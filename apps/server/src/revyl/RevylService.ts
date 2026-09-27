/**
 * RevylService - Revyl cloud devices through the `revyl` CLI signed in on this machine.
 *
 * The CLI owns sign-in and its list of active sessions, so sessions an agent starts with
 * `revyl device start` show up here too. Every call is one CLI run (about a second, mostly
 * Revyl's API); input names the session explicitly so parallel sessions never cross.
 *
 * @module revyl/RevylService
 */
import {
  RevylError,
  type RevylInputRequest,
  type RevylSession,
  type RevylStartInput,
  type RevylState,
  type RevylStopInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

const RawSession = Schema.Struct({
  session_id: Schema.String,
  platform: Schema.String,
  viewer_url: Schema.optional(Schema.String),
  whep_url: Schema.optional(Schema.NullOr(Schema.String)),
  screen_width: Schema.optional(Schema.NullOr(Schema.Number)),
  screen_height: Schema.optional(Schema.NullOr(Schema.Number)),
  started_at: Schema.optional(Schema.String),
});
const decodeSessions = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(RawSession)));
const decodeAuth = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ authenticated: Schema.Boolean, email: Schema.optional(Schema.String) }),
  ),
);

/** A session as the client needs it; one without a screen size yet is still starting. */
export function revylSessionOf(raw: typeof RawSession.Type): RevylSession | null {
  const platform = raw.platform === "android" ? "android" : raw.platform === "ios" ? "ios" : null;
  const width = Math.round(raw.screen_width ?? 0);
  const height = Math.round(raw.screen_height ?? 0);
  if (platform === null || raw.session_id.trim() === "" || width <= 0 || height <= 0) return null;
  return {
    sessionId: raw.session_id,
    platform,
    viewerUrl: raw.viewer_url ?? `https://app.revyl.ai/sessions/${raw.session_id}`,
    ...(raw.whep_url ? { whepUrl: raw.whep_url } : {}),
    screenWidth: width,
    screenHeight: height,
    startedAt: raw.started_at ?? "",
  };
}

/** Sessions from `revyl device list --json`, newest first. */
export function parseRevylSessions(stdout: string): ReadonlyArray<RevylSession> {
  const raw = decodeSessions(stdout);
  if (raw._tag === "None") return [];
  return raw.value
    .map(revylSessionOf)
    .filter((session) => session !== null)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

/** The CLI arguments for one input; coordinates are screen points. */
export function revylInputArgs(request: RevylInputRequest): ReadonlyArray<string> {
  const session = ["--session-id", request.sessionId, "--json"];
  const input = request.input;
  switch (input._tag) {
    case "tap":
      return ["device", "tap", "--x", `${input.x}`, "--y", `${input.y}`, ...session];
    case "longPress":
      return ["device", "long-press", "--x", `${input.x}`, "--y", `${input.y}`, ...session];
    case "swipe":
      return [
        "device",
        "swipe",
        "--x",
        `${input.x}`,
        "--y",
        `${input.y}`,
        "--direction",
        input.direction,
        ...session,
      ];
    case "type":
      // `=` keeps text that starts with a dash from reading as a flag.
      return ["device", "type", `--text=${input.text}`, ...session];
    case "key":
      return ["device", "key", "--key", input.key, ...session];
    case "home":
      return ["device", "home", ...session];
    case "back":
      return ["device", "back", ...session];
    case "navigate":
      return ["device", "navigate", `--url=${input.url}`, ...session];
  }
}

/** The CLI's own explanation from a failed run, without its upgrade notice. */
function failureText(output: { readonly stdout: string; readonly stderr: string }): string {
  const lines = `${output.stderr}\n${output.stdout}`
    .split("\n")
    .map((line) => line.replace(/^[✗⚠!\s]+/u, "").trim())
    .filter((line) => line !== "" && !/new version|upgrade/i.test(line));
  return lines[0] ?? "Revyl did not accept the request.";
}

export class RevylService extends Context.Service<
  RevylService,
  {
    readonly state: Effect.Effect<RevylState, RevylError>;
    readonly start: (input: RevylStartInput) => Effect.Effect<RevylSession, RevylError>;
    readonly stop: (input: RevylStopInput) => Effect.Effect<void, RevylError>;
    readonly input: (request: RevylInputRequest) => Effect.Effect<void, RevylError>;
  }
>()("t3/revyl/RevylService") {}

const NOT_INSTALLED = "Install the Revyl CLI on this machine: pip install revyl";

export const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // The CLI keeps a `.revyl/` session cache in its working directory; give it its own.
  const cwd = path.join((yield* ServerConfig.ServerConfig).stateDir, "revyl");
  yield* fs.makeDirectory(cwd, { recursive: true }).pipe(Effect.ignore);

  /** One CLI run; `null` when the CLI is not installed. */
  const run = (args: ReadonlyArray<string>, timeout: Duration.Input) =>
    runner.run({ command: "revyl", args, cwd, timeout }).pipe(
      Effect.map((output) => output as ProcessRunner.ProcessRunOutput | null),
      Effect.catchTag("ProcessSpawnError", () => Effect.succeed(null)),
      Effect.mapError((error) => new RevylError({ message: error.message })),
    );

  const runOk = Effect.fn("RevylService.runOk")(function* (
    args: ReadonlyArray<string>,
    timeout: Duration.Input = "30 seconds",
  ) {
    const output = yield* run(args, timeout);
    if (output === null) return yield* new RevylError({ message: NOT_INSTALLED });
    if (output.code !== 0) return yield* new RevylError({ message: failureText(output) });
    return output.stdout;
  });

  const listSessions = runOk(["device", "list", "--json"]).pipe(Effect.map(parseRevylSessions));

  const state: RevylService["Service"]["state"] = Effect.gen(function* () {
    const auth = yield* run(["auth", "status", "--json"], "15 seconds");
    if (auth === null) return { _tag: "unavailable" as const, reason: NOT_INSTALLED };
    // A signed-out CLI prints prose instead of JSON.
    const status = decodeAuth(auth.stdout);
    if (status._tag === "None" || !status.value.authenticated) {
      return { _tag: "signedOut" as const };
    }
    return {
      _tag: "ready" as const,
      ...(status.value.email ? { email: status.value.email } : {}),
      sessions: yield* listSessions,
    };
  }).pipe(Effect.withSpan("RevylService.state"));

  const start: RevylService["Service"]["start"] = Effect.fn("RevylService.start")(
    function* (input) {
      const before = new Set((yield* listSessions).map((session) => session.sessionId));
      // Provisioning a cloud device takes up to a couple of minutes.
      yield* runOk(
        ["device", "start", "--platform", input.platform, "--open=false", "--json"],
        "4 minutes",
      );
      const started = (yield* listSessions).find((session) => !before.has(session.sessionId));
      if (!started) {
        return yield* new RevylError({ message: "The device started but is not listed yet." });
      }
      return started;
    },
  );

  const stop: RevylService["Service"]["stop"] = (input) =>
    runOk(["device", "stop", "--session-id", input.sessionId, "--json"]).pipe(Effect.asVoid);

  const input: RevylService["Service"]["input"] = (request) =>
    runOk(revylInputArgs(request)).pipe(Effect.asVoid);

  return RevylService.of({ state, start, stop, input });
});

export const layer = Layer.effect(RevylService, make);
