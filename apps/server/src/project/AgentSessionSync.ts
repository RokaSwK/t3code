/**
 * AgentSessionSync - keeps sessions from the Codex and Claude apps arriving as threads.
 *
 * Both apps (and their CLIs) keep transcripts on disk, which {@link AgentSessionScanner} reads.
 * A pass creates a project for each repository they worked in that has none yet, then imports
 * the sessions not imported before into every project. It only ever adds threads: a session
 * already imported, or one continued here, is left as it is (see `importRecentAgentThreads`).
 * New threads take the name the app gave the session when it has one.
 *
 * Passes run in the background a little after startup and then on an interval, unless the
 * `agentSessionAutoImport` server setting is off, and on request from a client.
 *
 * @module project/AgentSessionSync
 */
import * as NodeOS from "node:os";

import {
  type AgentSessionSource,
  type AgentSessionSyncResult,
  type AgentSessionSyncStatus,
  AgentSessionScanError,
  CommandId,
  ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";

/** The first pass waits for startup to settle; later ones pick up new sessions. */
const FIRST_PASS_DELAY = Duration.minutes(1);
const PASS_INTERVAL = Duration.minutes(5);
/** Projects are created only for repositories worked in this recently, like the import. */
const PROJECT_WINDOW_MS = 30 * 24 * 60 * 60_000;
const MAX_TITLE_LENGTH = 120;

export class AgentSessionSync extends Context.Service<
  AgentSessionSync,
  {
    readonly status: Effect.Effect<AgentSessionSyncStatus>;
    /** Runs a pass now, or waits for the one already running and then runs another. */
    readonly syncNow: Effect.Effect<AgentSessionSyncResult, AgentSessionScanError>;
  }
>()("t3/project/AgentSessionSync") {}

/** Worktrees the agents make for a task belong to their repository, not a project of their own. */
export function isAgentWorktreePath(candidatePath: string): boolean {
  return /[\\/]\.(?:claude-worktrees|claude[\\/]worktrees|codex[\\/]worktrees)(?:[\\/]|$)/.test(
    candidatePath,
  );
}

const CodexIndexEntry = Schema.Struct({
  id: Schema.String,
  thread_name: Schema.optional(Schema.String),
});
const decodeCodexIndexEntry = Schema.decodeUnknownOption(Schema.fromJsonString(CodexIndexEntry));

const ClaudeDesktopSession = Schema.Struct({
  cliSessionId: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
});
const decodeClaudeDesktopSession = Schema.decodeUnknownOption(
  Schema.fromJsonString(ClaudeDesktopSession),
);

/**
 * Names the apps gave their sessions, keyed `source:sessionId`: the Codex app's thread index,
 * and the Claude app's record of each Code session, which points at its CLI session.
 */
export function parseAgentAppTitles(input: {
  readonly codexIndex: string;
  readonly claudeSessions: ReadonlyArray<string>;
}): Map<string, string> {
  const titles = new Map<string, string>();
  const add = (key: string, title: string | undefined) => {
    const trimmed = title?.replace(/\s+/g, " ").trim();
    if (trimmed) titles.set(key, trimmed.slice(0, MAX_TITLE_LENGTH));
  };
  for (const line of input.codexIndex.split("\n")) {
    const entry = decodeCodexIndexEntry(line);
    if (Option.isSome(entry)) add(`codex:${entry.value.id}`, entry.value.thread_name);
  }
  for (const contents of input.claudeSessions) {
    const session = decodeClaudeDesktopSession(contents);
    if (Option.isSome(session) && session.value.cliSessionId) {
      add(`claudeAgent:${session.value.cliSessionId}`, session.value.title);
    }
  }
  return titles;
}

const make = Effect.gen(function* () {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const projectService = yield* ProjectService.ProjectService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const importer = yield* AgentSessionImporter.AgentSessionImporter;
  const settings = yield* ServerSettings.ServerSettingsService;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const hostEnvironment = yield* HostProcessEnvironment;
  const platform = yield* HostProcessPlatform;
  const passes = yield* Semaphore.make(1);

  let status: AgentSessionSyncStatus = { running: false };

  const readText = (file: string) =>
    fileSystem.readFileString(file).pipe(Effect.orElseSucceed(() => ""));

  const readAppTitles = Effect.gen(function* () {
    const home = NodeOS.homedir();
    const codexHome = hostEnvironment.CODEX_HOME?.trim() || path.join(home, ".codex");
    const claudeAppDir =
      platform === "darwin"
        ? path.join(home, "Library", "Application Support", "Claude")
        : platform === "win32"
          ? path.join(hostEnvironment.APPDATA ?? path.join(home, "AppData", "Roaming"), "Claude")
          : path.join(home, ".config", "Claude");
    const sessionsDir = path.join(claudeAppDir, "claude-code-sessions");
    const files = yield* fileSystem
      .readDirectory(sessionsDir, { recursive: true })
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const claudeSessions = yield* Effect.forEach(
      files.filter((file) => file.endsWith(".json")),
      (file) => readText(path.join(sessionsDir, file)),
      { concurrency: 8 },
    );
    return parseAgentAppTitles({
      codexIndex: yield* readText(path.join(codexHome, "session_index.jsonl")),
      claudeSessions,
    });
  });

  const pass = Effect.gen(function* () {
    const scan = yield* scanner.scan;
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);

    let createdProjects = 0;
    for (const candidate of scan.candidates) {
      if (candidate.alreadyImported || candidate.projectId !== undefined) continue;
      // Repositories only: a folder an agent once ran in is not necessarily a project.
      if (!candidate.git || isAgentWorktreePath(candidate.path)) continue;
      const lastActiveMs = candidate.lastActiveAt ? Date.parse(candidate.lastActiveAt) : Number.NaN;
      if (!(nowMs - lastActiveMs <= PROJECT_WINDOW_MS)) continue;
      const created = yield* Effect.gen(function* () {
        const projectId = ProjectId.make(yield* crypto.randomUUIDv4);
        yield* projectService.create({
          commandId: CommandId.make(`agent-session-sync:project:${projectId}`),
          projectId,
          title: candidate.title,
          workspaceRoot: candidate.path,
          createWorkspaceRootIfMissing: false,
          defaultModelSelection: null,
        });
      }).pipe(
        Effect.provideService(ServerConfig.ServerConfig, serverConfig),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(WorkspacePaths.WorkspacePaths, workspacePaths),
        Effect.exit,
      );
      if (Exit.isSuccess(created)) createdProjects += 1;
      else
        yield* Effect.logWarning("agent session sync could not create a project", {
          path: candidate.path,
        });
    }

    const titles = yield* readAppTitles;
    const titleFor = (source: AgentSessionSource, sessionId: string) =>
      titles.get(`${source}:${sessionId}`);
    const projects = yield* projectStore
      .listShells()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    let addedThreads = 0;
    let skippedThreads = 0;
    for (const project of projects) {
      const result = yield* importer.importRecentAgentThreads(
        { projectId: project.id, expectedWorkspaceRoot: project.workspaceRoot },
        { titleFor },
      ).pipe(Effect.exit);
      if (Exit.isFailure(result)) continue;
      skippedThreads += result.value.skippedCount;
      addedThreads += result.value.importedCount;
    }
    return { addedThreads, createdProjects, skippedThreads } satisfies AgentSessionSyncResult;
  });

  const syncNow = passes.withPermit(
    Effect.gen(function* () {
      status = { ...status, running: true };
      const result = yield* Effect.exit(pass);
      const lastRunAt = DateTime.formatIso(yield* DateTime.now);
      if (Exit.isSuccess(result)) {
        status = { running: false, lastRunAt, lastResult: result.value };
        return result.value;
      }
      status = {
        running: false,
        lastRunAt,
        ...(status.lastResult ? { lastResult: status.lastResult } : {}),
        error: "Could not read the Codex and Claude sessions on this machine.",
      };
      return yield* Effect.failCause(result.cause);
    }),
  );

  const autoImportEnabled = settings.getSettings.pipe(
    Effect.map((current) => current.agentSessionAutoImport !== false),
    Effect.orElseSucceed(() => false),
  );

  yield* Effect.gen(function* () {
    yield* Effect.sleep(FIRST_PASS_DELAY);
    for (;;) {
      if (yield* autoImportEnabled) yield* Effect.exit(syncNow);
      yield* Effect.sleep(PASS_INTERVAL);
    }
  }).pipe(Effect.forkScoped);

  return AgentSessionSync.of({
    status: Effect.sync(() => status),
    syncNow,
  });
});

export const layer = Layer.effect(AgentSessionSync, make);
