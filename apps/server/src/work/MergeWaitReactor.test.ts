import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  SlackError,
  type SlackState,
  type ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { SlackService } from "../slack/SlackService.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { WorkThreads, presentWorkThread } from "./WorkThreads.ts";
import * as MergeWaitReactor from "./MergeWaitReactor.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider needed"),
} as ProviderAdapterV2Shape;
const replayLayer = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "personal-merge-waits" },
  ProviderAdapterRegistry.makeLayer([adapter]),
  { databaseLayer: SqlitePersistenceMemory, runEffectWorker: false },
);
const testLayer = Layer.mergeAll(
  replayLayer,
  EventStore.layer.pipe(Layer.provide(SqlitePersistenceMemory)),
);
const AT = "1970-01-01T00:00:00.000Z";
let harnessSerial = 0;
const URL = "https://acme.slack.com/archives/C123/p1700000000000000";
const pr = (changes: Partial<ThreadPullRequestSnapshot> = {}) => ({
  host: "github.com",
  repository: "acme/app",
  number: 1,
  url: "https://github.com/acme/app/pull/1",
  source: "manual" as const,
  linkedAt: AT,
  stack: null,
  snapshot: {
    state: "open" as const,
    title: "Fix",
    headBranch: "fix",
    baseBranch: "main",
    isDraft: false,
    syncedAt: AT,
    updatedAt: AT,
    ...changes,
  },
});
const harness = Effect.gen(function* () {
  const ID = ThreadId.make(`merge-wait-${harnessSerial++}`);
  const engine = yield* Orchestrator.OrchestratorV2;
  let serial = 0;
  const secrets = new Map<string, Uint8Array>();
  const reactions = new Set<string>();
  let failSlack = false;
  let dismissed = false;
  const dispatch: typeof engine.dispatch = (command) =>
    engine.dispatch({ ...command, commandId: CommandId.make(`${ID}:${command.commandId}`) });
  yield* dispatch({
    type: "thread.create",
    commandId: CommandId.make("create"),
    threadId: ID,
    projectId: ProjectId.make("project"),
    title: "Waiting",
    modelSelection: { instanceId, model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "fix",
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
    linkedSlackThreads: [URL],
  });
  yield* dispatch({
    type: "thread.pull-request.link",
    commandId: CommandId.make("link"),
    threadId: ID,
    host: "github.com",
    repository: "acme/app",
    number: 1,
    url: pr().url,
    source: "manual",
  });
  yield* dispatch({
    type: "thread.pull-request-link.sync",
    commandId: CommandId.make("initial-sync"),
    threadId: ID,
    host: "github.com",
    repository: "acme/app",
    number: 1,
    snapshot: pr().snapshot,
    stack: null,
  });
  const shell = engine.getShellSnapshot().pipe(
    Effect.map((snapshot) => ({
      ...snapshot,
      threads: [...snapshot.threads, ...snapshot.archivedThreads]
        .filter((thread) => thread.id === ID)
        .map(presentWorkThread),
    })),
  );
  const dependencies = Layer.mergeAll(
    Layer.mock(WorkThreads)({
      getShellSnapshot: () => shell.pipe(Effect.map((snapshot) => ({ ...snapshot, projects: [] }))),
    }),
    Layer.mock(ServerSecretStore)({
      get: (key) => Effect.sync(() => Option.fromUndefinedOr(secrets.get(key))),
      set: (key, value) =>
        Effect.sync(() => {
          secrets.set(key, value);
        }),
    }),
    Layer.mock(SlackService)({
      current: Effect.succeed({
        connection: {
          status: "connected",
          clientId: "1.2",
          teamName: "Acme",
          teamUrl: "https://acme.slack.com/",
          userId: "U1",
          userName: "ada",
        },
        sync: { channelCount: 0, availableChannelCount: 0, syncedChannelCount: 0 },
        threads: [],
        conversations: [],
        mentions: [],
        events: { status: "off" },
        dismissed: [],
        includedChannelIds: [],
        conversationOwners: [],
        conversationWaits: [],
        reviewRequests: [],
        authoredPullRequests: [],
        replyDrafts: [],
        devin: { status: "disconnected" },
      } satisfies SlackState),
      setReaction: (input) =>
        failSlack
          ? Effect.fail(new SlackError({ operation: "setReaction", message: "offline" }))
          : Effect.sync(() => {
              if (input.reacted) reactions.add(input.name);
              else reactions.delete(input.name);
            }),
      setDismissed: (input) =>
        Effect.sync(() => {
          dismissed = input.dismissed;
        }),
    }),
  );
  const create = MergeWaitReactor.make.pipe(Effect.provide(dependencies));
  const startWait = () =>
    dispatch({
      type: "thread.snooze",
      commandId: CommandId.make(`wait-${serial++}`),
      threadId: ID,
      snoozedUntil: null,
      untilMerge: true,
    });
  const sync = (changes: Partial<ThreadPullRequestSnapshot>) =>
    dispatch({
      type: "thread.pull-request-link.sync",
      commandId: CommandId.make(`sync-${serial++}`),
      threadId: ID,
      host: "github.com",
      repository: "acme/app",
      number: 1,
      snapshot: pr(changes).snapshot,
      stack: null,
    });
  return {
    id: ID,
    create,
    dispatch,
    startWait,
    sync,
    shell,
    reactions,
    get dismissed() {
      return dismissed;
    },
    fail: (value: boolean) => {
      failSlack = value;
    },
    restoreShippedJob: () => {
      secrets.set(
        "merge-wait-reactions",
        new TextEncoder().encode(
          JSON.stringify({ cursor: 0, pending: [{ url: URL, state: "shipped" }] }),
        ),
      );
    },
  };
});
const drain = (reactor: Effect.Success<typeof MergeWaitReactor.make>) =>
  reactor.enqueue().pipe(Effect.andThen(reactor.drain));

it.layer(Layer.mergeAll(NodeServices.layer, testLayer))("merge waits", (it) => {
  it.effect("persists the wait and settles without a Slack tick after merge", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const reactor = yield* h.create;
      yield* h.startWait();
      yield* drain(reactor);
      const thread = (yield* h.shell).threads[0]!;
      expect(thread.waitingForMergeAt).toBe(AT);

      expect(h.reactions).toEqual(new Set(["clock3"]));
      yield* h.sync({ state: "merged", mergedAt: AT });
      yield* drain(reactor);
      yield* drain(reactor);
      expect((yield* h.shell).threads[0]).toMatchObject({
        waitingForMergeAt: null,
        settledOverride: "settled",
      });
      expect(h.reactions.size).toBe(0);
      expect(h.dismissed).toBe(true);
    }),
  );

  it.effect.each([
    { checksState: "failing" },
    { mergeability: "conflicting" },
    { reviewDecision: "changes-requested" },
    { state: "closed" },
  ] satisfies Partial<ThreadPullRequestSnapshot>[])("wakes rather than settles when %j", (change) =>
    Effect.gen(function* () {
      const h = yield* harness;
      const reactor = yield* h.create;
      yield* h.startWait();
      yield* drain(reactor);
      yield* h.sync(change);
      yield* drain(reactor);
      yield* drain(reactor);
      expect((yield* h.shell).threads[0]).toMatchObject({
        waitingForMergeAt: null,
        settledOverride: null,
      });
      expect(h.reactions.size).toBe(0);
      expect(h.dismissed).toBe(false);
    }),
  );

  it.effect("retries Slack cleanup after restart and preserves manual wake", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const reactor = yield* h.create;
      yield* h.startWait();
      yield* drain(reactor);
      h.fail(true);
      yield* h.dispatch({
        type: "thread.unsnooze",
        commandId: CommandId.make("wake"),
        threadId: h.id,
        reason: "user",
      });
      yield* drain(reactor);
      expect(h.reactions.has("clock3")).toBe(true);
      h.fail(false);
      const restarted = yield* h.create;
      yield* drain(restarted);
      expect(h.reactions.size).toBe(0);
      yield* h.sync({ state: "merged", mergedAt: AT });
      yield* drain(restarted);
      expect((yield* h.shell).threads[0]?.settledOverride).toBe(null);
    }),
  );

  it.effect("leaves Slack untouched when a PR merges without a wait", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const reactor = yield* h.create;
      yield* drain(reactor);
      yield* h.sync({ state: "open", title: "Fix again" });
      yield* drain(reactor);
      expect(h.reactions.size).toBe(0);
      yield* h.sync({ state: "merged", mergedAt: AT });
      yield* drain(reactor);
      expect(h.reactions.size).toBe(0);
      expect(h.dismissed).toBe(false);
      expect((yield* h.shell).threads[0]?.settledOverride).toBe(null);
    }),
  );

  it.effect("discards a pending tick from an older server", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.restoreShippedJob();
      const reactor = yield* h.create;
      yield* drain(reactor);
      expect(h.reactions.size).toBe(0);
      expect(h.dismissed).toBe(false);
    }),
  );

  it.effect.each(["thread.archive", "thread.delete"] as const)(
    "%s cancels the wait and cleans the reaction",
    (type) =>
      Effect.gen(function* () {
        const h = yield* harness;
        const reactor = yield* h.create;
        yield* h.startWait();
        yield* drain(reactor);
        yield* h.dispatch({ type, commandId: CommandId.make(type), threadId: h.id });
        yield* drain(reactor);
        expect(h.reactions.size).toBe(0);
        expect(h.dismissed).toBe(false);
      }),
  );

  it.effect("a new message cancels the wait and clears the Slack clock", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const reactor = yield* h.create;
      yield* h.startWait();
      yield* drain(reactor);
      yield* h.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("resume"),
        threadId: h.id,
        messageId: MessageId.make("resume-message"),
        text: "Continue",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* drain(reactor);
      expect((yield* h.shell).threads[0]?.waitingForMergeAt).toBeNull();
      expect(h.reactions.size).toBe(0);
    }),
  );

  it.effect("rejects an unlinked wait and a stale merge resolution", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const stale = yield* Effect.exit(
        h.dispatch({
          type: "thread.merge-wait.resolve",
          threadId: h.id,
          commandId: CommandId.make("stale"),
          waitingForMergeAt: AT,
          outcome: "merged",
        }),
      );
      expect(stale._tag).toBe("Failure");
      yield* h.dispatch({
        type: "thread.pull-request.unlink",
        threadId: h.id,
        commandId: CommandId.make("unlink"),
        host: "github.com",
        repository: "acme/app",
        number: 1,
      });
      const rejected = yield* Effect.exit(h.startWait());
      expect(rejected._tag).toBe("Failure");
    }),
  );
});
