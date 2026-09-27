/**
 * Pure rules for "your conversations": which Slack threads are yours, who replied last, and
 * what Devin is doing in them. Kept apart from the service so they can be tested without Slack.
 *
 * Devin works in Slack as a bot user. Every message it posts carries a link to its session,
 * and automations post the first message on your behalf as `<@you>: request`.
 */
import type { DevinSessionState, SlackReplyAuthor } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { isSlackThreadRoot, slackPullRequestLinks, type SlackApiMessage } from "./slackFeed.ts";

/** Devin's Slack app, the same in every workspace; the name is the fallback. */
export const DEVIN_SLACK_APP_ID = "A06A3TU8H39";

/** Devin threads are looked for this far back. */
export const DEVIN_SEARCH_WINDOW_MS = 14 * 24 * 60 * 60_000;
export const DEVIN_SEARCH_INTERVAL_MS = 2 * 60_000;
export const DEVIN_SEARCH_MAX_PAGES = 10;

/** Devin's user and bot, which is how its messages are recognized. */
export interface DevinIdentity {
  readonly userId: string;
  readonly botId?: string;
}

interface SlackApiUserLike {
  readonly id: string;
  readonly name?: string;
  readonly real_name?: string;
  readonly deleted?: boolean;
  readonly is_bot?: boolean;
  readonly profile?: { readonly bot_id?: string; readonly api_app_id?: string };
}

export function findDevinUser(users: ReadonlyArray<SlackApiUserLike>): DevinIdentity | undefined {
  const bots = users.filter((user) => user.is_bot && !user.deleted);
  const user =
    bots.find((candidate) => candidate.profile?.api_app_id === DEVIN_SLACK_APP_ID) ??
    bots.find((candidate) => (candidate.real_name ?? candidate.name)?.toLowerCase() === "devin");
  if (!user) return undefined;
  return { userId: user.id, ...(user.profile?.bot_id ? { botId: user.profile.bot_id } : {}) };
}

export function isDevinMessage(message: SlackApiMessage, devin: DevinIdentity | undefined) {
  if (!devin) return false;
  return message.user === devin.userId || (!!devin.botId && message.bot_id === devin.botId);
}

const DEVIN_SESSION_URL = /https:\/\/app\.devin\.ai\/sessions\/([0-9a-f]{32})/g;

/** Devin session ids linked from `text`, in order of appearance. */
export function devinSessionIds(text: string): string[] {
  return [...new Set([...text.matchAll(DEVIN_SESSION_URL)].map((match) => match[1]!))];
}

export function devinSessionUrl(id: string): string {
  return `https://app.devin.ai/sessions/${id}`;
}

/** Devin posts this once a session goes to sleep; tagging it again starts it back up. */
function isDevinStopNotice(message: SlackApiMessage): boolean {
  return /tag @devin here to continue/i.test(message.text ?? "");
}

/** Edited-away and empty bot updates are not replies anyone wrote. */
function hasContent(message: SlackApiMessage): boolean {
  return (message.text ?? "").trim().length > 0 || (message.files?.length ?? 0) > 0;
}

export interface SlackConversationSummary {
  readonly root: SlackApiMessage;
  readonly startedByMe: boolean;
  /** You started it or wrote anything in it. */
  readonly mine: boolean;
  readonly lastReply?: {
    readonly by: SlackReplyAuthor;
    readonly userId?: string;
    readonly ts: string;
  };
  readonly pullRequestText: string;
  readonly devin?: {
    readonly sessionIds: ReadonlyArray<string>;
    readonly stopped: boolean;
    readonly lastMessageTs: string;
  };
  /** Newest message in the conversation, root included. */
  readonly latestTs: string;
}

/**
 * Reads a conversation (`conversations.replies`, root first). An automation's root posted by
 * Devin that starts with your mention counts as started by you.
 */
export function summarizeSlackConversation(
  messages: ReadonlyArray<SlackApiMessage>,
  me: string,
  devin: DevinIdentity | undefined,
): SlackConversationSummary | undefined {
  const root = messages.find(isSlackThreadRoot);
  if (!root) return undefined;
  const startedByMe =
    root.user === me || (isDevinMessage(root, devin) && (root.text ?? "").startsWith(`<@${me}>`));
  const replies = messages.filter((message) => message.ts !== root.ts && hasContent(message));
  const devinMessages = messages.filter((message) => isDevinMessage(message, devin));
  const last = replies.at(-1);
  const sessionIds = devinSessionIds(devinMessages.map((message) => message.text ?? "").join(" "));
  const latestDevin = devinMessages.findLast(hasContent);
  return {
    root,
    startedByMe,
    mine: startedByMe || replies.some((message) => message.user === me),
    ...(last
      ? {
          lastReply: {
            by: last.user === me ? "me" : isDevinMessage(last, devin) ? "devin" : "other",
            ...(last.user ? { userId: last.user } : {}),
            ts: last.ts,
          },
        }
      : {}),
    pullRequestText: messages.map((message) => message.text ?? "").join("\n"),
    ...(latestDevin && sessionIds.length > 0
      ? {
          devin: {
            sessionIds,
            stopped: isDevinStopNotice(latestDevin),
            lastMessageTs: latestDevin.ts,
          },
        }
      : {}),
    latestTs: messages.reduce(
      (latest, message) =>
        Number.parseFloat(message.ts) > Number.parseFloat(latest) ? message.ts : latest,
      root.ts,
    ),
  };
}

/** PRs a whole conversation links to; the root's come first. */
export function slackConversationPullRequests(summary: SlackConversationSummary) {
  return slackPullRequestLinks(summary.pullRequestText);
}

/** A `search.messages` match; only where it lives matters here. */
export interface SlackApiSearchMatch {
  readonly ts?: string;
  readonly permalink?: string;
  readonly channel?: { readonly id?: string };
}

/** The conversation a search match belongs to, from its permalink's `thread_ts`. */
export function slackSearchMatchThread(
  match: SlackApiSearchMatch,
): { readonly channelId: string; readonly ts: string; readonly messageTs: string } | undefined {
  const channelId = match.channel?.id;
  if (!channelId || !match.ts) return undefined;
  let threadTs: string | null = null;
  try {
    threadTs = match.permalink ? new URL(match.permalink).searchParams.get("thread_ts") : null;
  } catch {
    threadTs = null;
  }
  return { channelId, ts: threadTs ?? match.ts, messageTs: match.ts };
}

/** Slack's `after:` takes a day and is exclusive. */
export function slackSearchAfterDate(ms: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(ms - 24 * 60 * 60_000)).slice(0, 10);
}

/** Devin's API session status, reduced to what the Work page acts on. */
export function devinSessionState(
  status: string | undefined,
  detail: string | null | undefined,
): DevinSessionState | undefined {
  switch (status) {
    case "new":
    case "claimed":
    case "resuming":
      return "working";
    case "running":
      if (detail === "waiting_for_user" || detail === "waiting_for_approval") return "waiting";
      if (detail === "finished") return "finished";
      return "working";
    case "exit":
      return "finished";
    case "error":
      return "error";
    case "suspended":
      return detail === "inactivity" || detail === "user_request" ? "suspended" : "error";
    default:
      return undefined;
  }
}

/** Open sessions are checked often; ones that stopped only in case they were woken again. */
export function devinSessionRecheckMs(state: DevinSessionState | undefined): number {
  return state === "working" || state === "waiting" ? 60_000 : 10 * 60_000;
}

/** How long to wait before reading one of your conversations again. */
export function slackConversationDelayMs(latestActivityMs: number, now: number): number {
  const age = now - latestActivityMs;
  if (age < 60 * 60_000) return 60_000;
  if (age < 6 * 60 * 60_000) return 5 * 60_000;
  return 15 * 60_000;
}
