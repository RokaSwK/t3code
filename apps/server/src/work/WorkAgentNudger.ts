/**
 * WorkAgentNudger - tells the Work agent when something new needs the user.
 *
 * With `workAgentAutoTriage` on, it looks at the Work page's Needs me group every few minutes.
 * Items that were not there last time go to the Work agent's thread as one message, when that
 * thread is idle, at most once per {@link MIN_NUDGE_GAP_MS}. What was already sent is kept
 * with the other secrets, so a restart does not send it again.
 *
 * @module work/WorkAgentNudger
 */
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { buildWorkOverview } from "../mcp/toolkits/work/handlers.ts";
import type { WorkItem } from "../mcp/toolkits/work/tools.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as WorkThreads from "./WorkThreads.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SlackService from "../slack/SlackService.ts";

const CHECK_INTERVAL = Duration.minutes(3);
const MIN_NUDGE_GAP_MS = 15 * 60_000;
const SEEN_SECRET = "work-agent-seen";
const MAX_ITEMS_PER_NUDGE = 12;

const Seen = Schema.Array(Schema.String);
const decodeSeen = Schema.decodeUnknownOption(Schema.fromJsonString(Seen));
const encodeSeen = Schema.encodeSync(Schema.fromJsonString(Seen));

/** The message the Work agent gets: what is new, and the same limits as its first prompt. */
export function workAgentNudgeMessage(items: ReadonlyArray<WorkItem>): string {
  const lines = items.slice(0, MAX_ITEMS_PER_NUDGE).map((item) => {
    const conversation = item.conversation;
    const what = conversation
      ? `#${conversation.channel} · ${conversation.author}: ${conversation.text}`
      : (item.t3Threads[0]?.title ?? item.id);
    const link = conversation ? ` (${conversation.permalink})` : "";
    return `- ${item.reason} — ${what}${link}`;
  });
  const more =
    items.length > MAX_ITEMS_PER_NUDGE ? [`- and ${items.length - MAX_ITEMS_PER_NUDGE} more`] : [];
  return [
    "New in Needs me since you last looked:",
    ...lines,
    ...more,
    "",
    "Look into these with the Work tools and tell me what needs me and what you would do next. Keep to the same limits as before: do not post in Slack, and ask before starting or messaging threads.",
  ].join("\n");
}

/** Items in `current` that were not in `seen`, and what to remember next. */
export function newWorkItems(
  current: ReadonlyArray<WorkItem>,
  seen: ReadonlySet<string>,
): ReadonlyArray<WorkItem> {
  return current.filter((item) => !seen.has(item.id));
}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const slack = yield* SlackService.SlackService;
  const snapshots = yield* WorkThreads.WorkThreads;
  const engine = yield* ThreadManagement.ThreadManagementService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;

  let seen: ReadonlySet<string> = yield* secrets.get(SEEN_SECRET).pipe(
    Effect.map((stored) =>
      Option.flatMap(stored, (bytes) => decodeSeen(new TextDecoder().decode(bytes))),
    ),
    Effect.map((stored) => new Set(Option.getOrElse(stored, () => []))),
    Effect.orElseSucceed(() => new Set<string>()),
  );
  let lastNudgeAt = 0;

  const check = Effect.gen(function* () {
    const current = yield* settings.getSettings;
    const threadIdText = current.workAgentThreadId;
    if (current.workAgentAutoTriage !== true || !threadIdText) return;
    const thread = yield* snapshots.getThreadShellById(ThreadId.make(threadIdText));
    if (Option.isNone(thread) || thread.value.archivedAt !== null) return;
    const agent = thread.value;
    const busy =
      agent.latestTurn?.state === "running" ||
      agent.hasPendingApprovals ||
      agent.hasPendingUserInput;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    if (busy || nowMs - lastNudgeAt < MIN_NUDGE_GAP_MS) return;

    const shell = yield* snapshots.getShellSnapshot();
    const overview = buildWorkOverview({
      threads: shell.threads,
      projects: shell.projects,
      slack: yield* slack.current,
      workProjectRootIds: current.workProjectRootIds,
      workGitHubOwners: current.workGitHubOwners,
      workIgnoredItems: current.workIgnoredItems,
      workSnoozedItems: current.workSnoozedItems,
      statuses: ["needs"],
      includeNewThreads: false,
      limit: 100,
      now: nowMs,
    });
    // The agent's own thread is where the nudge lands; it is never news to itself.
    const items = overview.items.filter(
      (item) => !item.t3Threads.some((entry) => entry.threadId === agent.id),
    );
    const fresh = newWorkItems(items, seen);
    // Remember exactly what needs the user now, so an item that leaves and returns is news.
    seen = new Set(items.map((item) => item.id));
    yield* secrets
      .set(SEEN_SECRET, new TextEncoder().encode(encodeSeen([...seen])))
      .pipe(Effect.ignore);
    if (fresh.length === 0) return;

    lastNudgeAt = nowMs;
    const uuid = yield* crypto.randomUUIDv4;
    yield* engine.sendToThread({
      mode: "auto",
      projectId: agent.projectId,
      createdBy: "system",
      creationSource: "server",
      commandId: CommandId.make(`work-agent:nudge:${uuid}`),
      threadId: agent.id,
      messageId: MessageId.make(uuid),
      text: workAgentNudgeMessage(fresh),
      attachments: [],
    });
  });

  yield* Effect.gen(function* () {
    for (;;) {
      yield* Effect.sleep(CHECK_INTERVAL);
      yield* check.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("work agent nudge failed", { cause: String(cause) }),
        ),
      );
    }
  }).pipe(Effect.forkScoped);
});

export const layer = Layer.effectDiscard(make);
