import { CommandId, parseSlackThreadUrl } from "@t3tools/contracts";
import { mergeWaitOutcome } from "@t3tools/shared/threadPullRequests";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Schedule from "effect/Schedule";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as SlackService from "../slack/SlackService.ts";
import { forkParked } from "../serverActivation.ts";

const Journal = Schema.Struct({
  cursor: Schema.Number,
  pending: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      state: Schema.Literals(["waiting", "merged", "cancelled"]),
    }),
  ),
});
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Journal));
const encode = Schema.encodeSync(Schema.fromJsonString(Journal));
const JOURNAL_KEY = "merge-wait-reactions";
const PAGE_SIZE = 500;

/** Replays lifecycle events so reaction changes survive disconnects and server restarts. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const slack = yield* SlackService.SlackService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const stored = yield* secrets.get(JOURNAL_KEY);
  const initial = Option.isSome(stored) ? decode(new TextDecoder().decode(stored.value)) : null;
  let cursor = initial?.cursor ?? (yield* engine.latestSequence);
  const pending = new Map(initial?.pending.map((job) => [job.url, job.state]));
  let seed = initial === null;
  const save = () =>
    secrets.set(
      JOURNAL_KEY,
      new TextEncoder().encode(
        encode({
          cursor,
          pending: [...pending].map(([url, state]) => ({ url, state })),
        }),
      ),
    );

  const sweep = Effect.gen(function* () {
    const snapshot = yield* snapshots.getShellSnapshot();
    if (seed) {
      for (const thread of snapshot.threads) {
        if (thread.waitingForMergeAt != null) {
          for (const url of thread.linkedSlackThreads ?? []) pending.set(url, "waiting");
        }
      }
      seed = false;
    }
    for (;;) {
      const events = yield* Stream.runCollect(engine.readEvents(cursor, PAGE_SIZE));
      for (const event of events) {
        if (event.type === "thread.snoozed" && event.payload.linkedSlackThreads) {
          for (const url of event.payload.linkedSlackThreads) {
            pending.set(url, event.payload.waitingForMergeAt != null ? "waiting" : "cancelled");
          }
        } else if (event.type === "thread.unsnoozed" && event.payload.mergeWait) {
          for (const url of event.payload.linkedSlackThreads ?? [])
            pending.set(url, event.payload.mergeWait);
        }
        cursor = event.sequence;
      }
      if (events.length < PAGE_SIZE) break;
    }
    // Save before external writes; retries are idempotent and incomplete jobs remain durable.
    yield* save();
    for (const thread of snapshot.threads) {
      if (thread.waitingForMergeAt == null || thread.archivedAt !== null) continue;
      const raisedHand =
        thread.hasPendingApprovals ||
        thread.hasPendingUserInput ||
        thread.session?.status === "running" ||
        thread.session?.status === "starting" ||
        (thread.session?.status === "error" && thread.session.updatedAt > thread.waitingForMergeAt);
      const outcome = raisedHand ? "wake" : mergeWaitOutcome(thread.pullRequests);
      if (outcome === "waiting") continue;
      yield* engine
        .dispatch({
          type: "thread.merge-wait.resolve",
          commandId: CommandId.make(
            `merge-wait:${thread.id}:${thread.waitingForMergeAt}:${outcome}:${snapshot.snapshotSequence}`,
          ),
          threadId: thread.id,
          waitingForMergeAt: thread.waitingForMergeAt,
          outcome,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not resolve merge wait", { threadId: thread.id, error }),
          ),
        );
    }
    if ((yield* slack.current).connection.status !== "connected") return;
    for (const [url, state] of pending) {
      const ref = parseSlackThreadUrl(url);
      if (!ref) {
        pending.delete(url);
        continue;
      }
      const input = { channelId: ref.channelId, ts: ref.ts };
      const done = yield* Effect.gen(function* () {
        yield* slack.setReaction({ ...input, name: "clock3", reacted: state === "waiting" });
        if (state === "waiting" || state === "merged") {
          yield* slack.setReaction({
            ...input,
            name: "white_check_mark",
            reacted: state === "merged",
          });
          yield* slack.setDismissed({ ...input, dismissed: state === "merged" });
        }
        return true;
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not sync merge wait to Slack", { error }).pipe(Effect.as(false)),
        ),
      );
      if (done) pending.delete(url);
    }
    yield* save();
  });
  const worker = yield* makeDrainableWorker(() =>
    sweep.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Merge wait synchronization failed", { cause: String(cause) }),
      ),
    ),
  );
  const start = Effect.gen(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(
      Stream.runForEach(events, (event) =>
        [
          "thread.snoozed",
          "thread.unsnoozed",
          "thread.pull-request-linked",
          "thread.pull-request-synced",
          "thread.pull-request-unlinked",
          "thread.session-set",
        ].includes(event.type)
          ? worker.enqueue(undefined)
          : Effect.void,
      ),
    );
    yield* forkParked(
      worker.enqueue(undefined).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
    );
  });
  return { start, enqueue: () => worker.enqueue(undefined), drain: worker.drain };
});

export const layer = Layer.effectDiscard(make.pipe(Effect.flatMap((reactor) => reactor.start)));
