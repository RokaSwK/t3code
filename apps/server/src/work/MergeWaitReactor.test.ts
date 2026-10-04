import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  SlackError,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationShellSnapshot,
  type SlackState,
  type ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { SlackService } from "../slack/SlackService.ts";
import { decideOrchestrationCommand } from "../orchestration/decider.ts";
import { projectEvent } from "../orchestration/projector.ts";
import { isAutoSettlementCandidate } from "../orchestration/ThreadSettlementPolicy.ts";
import * as MergeWaitReactor from "./MergeWaitReactor.ts";

const AT = "1970-01-01T00:00:00.000Z";
const ID = ThreadId.make("merge-wait");
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
function model(): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    updatedAt: AT,
    threads: [
      {
        id: ID,
        projectId: ProjectId.make("project"),
        title: "Waiting",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "fix",
        worktreePath: null,
        pullRequests: [pr()],
        linkedSlackThreads: [URL],
        latestTurn: null,
        createdAt: AT,
        updatedAt: AT,
        archivedAt: null,
        deletedAt: null,
        settledOverride: null,
        settledAt: null,
        session: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
      },
    ],
  };
}
const harness = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  let state = model();
  let serial = 0;
  const events: OrchestrationEvent[] = [];
  const secrets = new Map<string, Uint8Array>();
  const reactions = new Set<string>();
  let failSlack = false;
  let dismissed = false;
  const dispatch = (command: OrchestrationCommand) =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({ command, readModel: state });
      for (const event of Array.isArray(decided) ? decided : [decided]) {
        const persisted = { ...event, sequence: state.snapshotSequence + 1 };
        state = yield* projectEvent(state, persisted);
        events.push(persisted);
      }
      return { sequence: state.snapshotSequence };
    }).pipe(Effect.provideService(Crypto.Crypto, crypto), Effect.orDie);
  const shell = (): OrchestrationShellSnapshot => ({
    ...state,
    threads: state.threads.map((thread) => ({
      ...thread,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    })),
  });
  const dependencies = Layer.mergeAll(
    Layer.mock(OrchestrationEngineService)({
      dispatch,
      latestSequence: Effect.sync(() => state.snapshotSequence),
      readEvents: (after, limit) =>
        Stream.fromArray(events.filter((e) => e.sequence > after).slice(0, limit)),
    }),
    Layer.mock(ProjectionSnapshotQuery)({ getShellSnapshot: () => Effect.sync(shell) }),
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
    events,
  };
});
const drain = (reactor: Effect.Success<typeof MergeWaitReactor.make>) =>
  reactor.enqueue().pipe(Effect.andThen(reactor.drain));

it.layer(NodeServices.layer)("merge waits", (it) => {
  it.effect(
    "persists the wait, protects it from age settlement, and settles without a Slack tick after merge",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const reactor = yield* h.create;
        yield* h.startWait();
        yield* drain(reactor);
        const thread = h.shell().threads[0]!;
        expect(thread.waitingForMergeAt).toBe(AT);
        expect(isAutoSettlementCandidate(thread, "2030-01-01T00:00:00.000Z")).toBe(false);
        expect(h.reactions).toEqual(new Set(["clock3"]));
        yield* h.sync({ state: "merged", mergedAt: AT });
        yield* drain(reactor);
        yield* drain(reactor);
        expect(h.shell().threads[0]).toMatchObject({
          waitingForMergeAt: null,
          settledOverride: "settled",
        });
        expect(h.reactions.size).toBe(0);
        expect(h.dismissed).toBe(true);
      }),
  );

  for (const change of [
    { checksState: "failing" },
    { mergeability: "conflicting" },
    { reviewDecision: "changes-requested" },
    { state: "closed" },
  ] satisfies Partial<ThreadPullRequestSnapshot>[]) {
    it.effect(`wakes rather than settles when ${JSON.stringify(change)}`, () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const reactor = yield* h.create;
        yield* h.startWait();
        yield* drain(reactor);
        yield* h.sync(change);
        yield* drain(reactor);
        yield* drain(reactor);
        expect(h.shell().threads[0]).toMatchObject({
          waitingForMergeAt: null,
          settledOverride: null,
        });
        expect(h.reactions.size).toBe(0);
        expect(h.dismissed).toBe(false);
      }),
    );
  }

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
        threadId: ID,
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
      expect(h.shell().threads[0]?.settledOverride).toBe(null);
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
      expect(h.shell().threads[0]?.settledOverride).toBe(null);
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

  for (const type of ["thread.archive", "thread.delete"] as const) {
    it.effect(`${type} cancels the wait and cleans the reaction`, () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const reactor = yield* h.create;
        yield* h.startWait();
        yield* drain(reactor);
        yield* h.dispatch({ type, commandId: CommandId.make(type), threadId: ID });
        yield* drain(reactor);
        expect(h.reactions.size).toBe(0);
        expect(h.dismissed).toBe(false);
      }),
    );
  }

  it.effect("a new message cancels the wait and clears the Slack clock", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const reactor = yield* h.create;
      yield* h.startWait();
      yield* drain(reactor);
      yield* h.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("resume"),
        threadId: ID,
        message: {
          messageId: MessageId.make("resume-message"),
          role: "user",
          text: "Continue",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: AT,
      });
      yield* drain(reactor);
      expect(h.shell().threads[0]?.waitingForMergeAt).toBeNull();
      expect(h.reactions.size).toBe(0);
      expect(
        h.events.some(
          (event) => event.type === "thread.unsnoozed" && event.payload.reason === "activity",
        ),
      ).toBe(true);
    }),
  );

  it.effect("rejects an unlinked wait and a stale merge resolution", () =>
    Effect.gen(function* () {
      const state = model();
      const unlinked = {
        ...state,
        threads: state.threads.map((thread) => ({ ...thread, pullRequests: [] })),
      };
      const rejected = yield* decideOrchestrationCommand({
        readModel: unlinked,
        command: {
          type: "thread.snooze",
          threadId: ID,
          commandId: CommandId.make("bad"),
          snoozedUntil: null,
          untilMerge: true,
        },
      }).pipe(Effect.flip);
      expect(rejected._tag).toBe("OrchestrationCommandInvariantError");
      const stale = yield* decideOrchestrationCommand({
        readModel: state,
        command: {
          type: "thread.merge-wait.resolve",
          threadId: ID,
          commandId: CommandId.make("stale"),
          waitingForMergeAt: AT,
          outcome: "merged",
        },
      }).pipe(Effect.flip);
      expect(stale._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
