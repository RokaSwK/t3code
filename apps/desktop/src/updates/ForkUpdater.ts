/**
 * ForkUpdater - in-app updates for fork builds without Apple signing.
 *
 * Electron's macOS updater refuses bundles that are not signed with a real identity, so fork
 * tracks cannot use it. This implements the same {@link ElectronUpdater} surface on top of
 * the track's GitHub release: check reads the release's assets, download streams the newest
 * archive for this machine, and install extracts it, verifies the ad-hoc signature, and hands
 * the bundle swap to a detached script that runs after the app quits. The update state
 * machine, IPC, and settings UI do not know the difference.
 *
 * @module ForkUpdater
 */
// @effect-diagnostics nodeBuiltinImport:off - the swap is a child process on the local disk.
// @effect-diagnostics globalFetchInEffect:off - streams a release archive to disk with progress.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  forkDesktopReleaseApiUrl,
  forkDesktopReleaseTag,
  pickForkDesktopAsset,
} from "@t3tools/shared/desktopReleaseChannels";
import { HostProcessArchitecture } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Electron from "electron";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import {
  ElectronUpdater,
  ElectronUpdaterCheckForUpdatesError,
  ElectronUpdaterDownloadUpdateError,
  ElectronUpdaterQuitAndInstallError,
} from "../electron/ElectronUpdater.ts";
import { forkAppBundlePath, forkSwapScript } from "./forkUpdateInstall.ts";

type Channel = "latest" | "nightly" | "personal";

interface ReleaseAsset {
  readonly name: string;
  readonly browser_download_url: string;
  readonly size: number;
}

interface Available {
  readonly version: string;
  readonly asset: ReleaseAsset;
}

const BUNDLE_NAME = "T3 Code.app";

const { logInfo, logError } = DesktopObservability.makeComponentLogger("fork-updater");

/** The updater's wrapped errors hide their cause from the UI; the log keeps ours, which are safe. */
const logFailure = (operation: string, cause: unknown) =>
  logError(`fork updater ${operation} failed`, {
    cause: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
  });

function run(command: string, args: ReadonlyArray<string>): Promise<void> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(command, [...args], (error, _stdout, stderr) => {
      if (error) reject(new Error(`${command} failed: ${stderr || error.message}`));
      else resolve();
    });
  });
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const events = new NodeEvents.EventEmitter();
  const appVersion = Electron.app.getVersion();
  const arch = yield* HostProcessArchitecture;
  const staging = NodePath.join(Electron.app.getPath("temp"), "t3-code-fork-update");
  let channel: Channel = "personal";
  let allowDowngrade = false;
  let available: Available | undefined;
  let downloaded: { readonly version: string; readonly archive: string } | undefined;

  const checkForUpdates = Effect.tryPromise({
    try: async () => {
      events.emit("checking-for-update");
      const response = await fetch(forkDesktopReleaseApiUrl(channel), {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": `t3-code-desktop/${appVersion}`,
        },
      });
      if (!response.ok) {
        throw new Error(
          `GitHub returned ${response.status} for release ${forkDesktopReleaseTag(channel)}.`,
        );
      }
      const release = (await response.json()) as {
        readonly body?: string;
        readonly assets?: ReadonlyArray<ReleaseAsset>;
      };
      const asset = pickForkDesktopAsset(release.assets ?? [], arch);
      // A track's newest build is the target even when it is older than the running one, so
      // switching tracks works; the running build itself is never reinstalled.
      if (!asset || asset.version === appVersion) {
        available = undefined;
        events.emit("update-not-available", { version: appVersion });
        return;
      }
      available = { version: asset.version, asset };
      events.emit("update-available", {
        version: asset.version,
        releaseNotes: release.body ?? null,
      });
    },
    catch: (cause) => new ElectronUpdaterCheckForUpdatesError({ channel, cause }),
  }).pipe(Effect.tapError((error) => logFailure("check", error.cause)));

  const downloadUpdate = Effect.tryPromise({
    try: async () => {
      const target = available;
      if (!target) throw new Error("No update is available to download.");
      await Effect.runPromise(logInfo("downloading release archive", { name: target.asset.name }));
      await NodeFS.promises.rm(staging, { recursive: true, force: true });
      await NodeFS.promises.mkdir(staging, { recursive: true });
      const archive = NodePath.join(staging, target.asset.name);
      const response = await fetch(target.asset.browser_download_url, {
        headers: { "user-agent": `t3-code-desktop/${appVersion}` },
      });
      if (!response.ok || !response.body) {
        throw new Error(`Download failed with status ${response.status}.`);
      }
      const total = Number(response.headers.get("content-length")) || target.asset.size || 0;
      const file = NodeFS.createWriteStream(archive);
      let received = 0;
      let lastPercent = -1;
      for await (const chunk of response.body) {
        received += chunk.byteLength;
        if (!file.write(chunk)) {
          await new Promise<void>((resolve) => file.once("drain", () => resolve()));
        }
        const percent = total > 0 ? Math.min(100, (received / total) * 100) : 0;
        if (Math.floor(percent) !== lastPercent) {
          lastPercent = Math.floor(percent);
          events.emit("download-progress", { percent, transferred: received, total });
        }
      }
      await new Promise<void>((resolve, reject) => {
        file.once("error", reject);
        file.end(() => resolve());
      });
      if (total > 0 && received !== total) {
        throw new Error(`Download ended early: ${received} of ${total} bytes.`);
      }
      downloaded = { version: target.version, archive };
      events.emit("download-progress", { percent: 100, transferred: received, total });
      events.emit("update-downloaded", { version: target.version });
    },
    catch: (cause) => new ElectronUpdaterDownloadUpdateError({ channel, cause }),
  }).pipe(Effect.tapError((error) => logFailure("download", error.cause)));

  const quitAndInstall = ({
    isSilent,
    isForceRunAfter,
  }: {
    readonly isSilent: boolean;
    readonly isForceRunAfter: boolean;
  }) =>
    Effect.tryPromise({
      try: async () => {
        const ready = downloaded;
        if (!ready) throw new Error("No downloaded update to install.");
        const appBundle = forkAppBundlePath(process.execPath);
        if (!appBundle) throw new Error(`Not running from an app bundle: ${process.execPath}`);
        // A swap that cannot write next to the bundle must fail here, while it can be shown.
        await NodeFS.promises.access(NodePath.dirname(appBundle), NodeFS.constants.W_OK);
        const extracted = NodePath.join(staging, "extracted");
        await NodeFS.promises.rm(extracted, { recursive: true, force: true });
        await run("/usr/bin/ditto", ["-x", "-k", ready.archive, extracted]);
        const newBundle = NodePath.join(extracted, BUNDLE_NAME);
        await NodeFS.promises.access(newBundle);
        await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", newBundle]);
        const script = NodePath.join(staging, "swap.sh");
        await NodeFS.promises.writeFile(
          script,
          forkSwapScript({
            pid: process.pid,
            appBundle,
            newBundle,
            previousBundle: NodePath.join(staging, "previous.app"),
          }),
          { mode: 0o755 },
        );
        const child = NodeChildProcess.spawn("/bin/sh", [script], {
          detached: true,
          stdio: "ignore",
        });
        child.unref();
        Electron.app.quit();
      },
      catch: (cause) =>
        new ElectronUpdaterQuitAndInstallError({ channel, isSilent, isForceRunAfter, cause }),
    }).pipe(Effect.tapError((error) => logFailure("install", error.cause)));

  return ElectronUpdater.of({
    // The release is addressed by channel; feed URLs are electron-updater's concern.
    setFeedURL: () => Effect.void,
    setAutoDownload: () => Effect.void,
    setAutoInstallOnAppQuit: () => Effect.void,
    setChannel: (next) =>
      Effect.sync(() => {
        if (next === "latest" || next === "nightly" || next === "personal") channel = next;
        available = undefined;
      }),
    setAllowPrerelease: () => Effect.void,
    allowDowngrade: Effect.sync(() => allowDowngrade),
    setAllowDowngrade: (value) =>
      Effect.sync(() => {
        allowDowngrade = value;
      }),
    setFullChangelog: () => Effect.void,
    setDisableDifferentialDownload: () => Effect.void,
    checkForUpdates,
    downloadUpdate,
    quitAndInstall,
    on: (eventName, listener) => {
      const untyped = listener as unknown as (...args: Array<unknown>) => void;
      return Effect.acquireRelease(
        Effect.sync(() => {
          events.on(eventName, untyped);
        }),
        () =>
          Effect.sync(() => {
            events.removeListener(eventName, untyped);
          }),
      ).pipe(Effect.asVoid);
    },
  });
});

export const layer = Layer.effect(ElectronUpdater, make);
