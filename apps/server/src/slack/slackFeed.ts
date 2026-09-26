/**
 * Pure rules for the Slack feed: which messages count as threads, how often a
 * channel is read, and how the feed is ordered. Kept apart from the service so
 * the polling policy can be tested without Slack.
 */

/** The fields we read from Slack's message objects. */
export interface SlackApiMessage {
  readonly ts: string;
  readonly thread_ts?: string;
  readonly subtype?: string;
  readonly user?: string;
  readonly bot_id?: string;
  readonly username?: string;
  readonly bot_profile?: { readonly name?: string; readonly icons?: { image_48?: string } };
  readonly text?: string;
  readonly files?: ReadonlyArray<unknown>;
  readonly edited?: unknown;
  readonly reply_count?: number;
  readonly latest_reply?: string;
  readonly reactions?: ReadonlyArray<{
    readonly name: string;
    readonly count: number;
    readonly users?: ReadonlyArray<string>;
  }>;
}

/** Only new-thread candidates show in the feed. */
export const SLACK_FEED_WINDOW_MS = 24 * 60 * 60_000;
export const SLACK_FEED_LIMIT = 150;

/** Channel membership changes rarely; re-list it this often. */
export const SLACK_CHANNEL_LIST_INTERVAL_MS = 10 * 60_000;

/** Housekeeping messages that are not conversation starters. */
const IGNORED_SUBTYPES = new Set([
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "channel_convert_to_private",
  "group_join",
  "group_leave",
  "group_topic",
  "group_purpose",
  "group_name",
  "group_archive",
  "group_unarchive",
  "pinned_item",
  "unpinned_item",
  "bot_add",
  "bot_remove",
  "tombstone",
]);

/** A message that starts a conversation, as opposed to a reply or a system notice. */
export function isSlackThreadRoot(message: SlackApiMessage): boolean {
  if (message.subtype !== undefined && IGNORED_SUBTYPES.has(message.subtype)) return false;
  return message.thread_ts === undefined || message.thread_ts === message.ts;
}

export function slackTsToMs(ts: string): number {
  return Math.floor(Number.parseFloat(ts) * 1000);
}

/**
 * How long to wait before reading a channel again. Busy channels are read
 * often and quiet ones rarely, so the request budget goes where new threads
 * are likely.
 */
export function slackPollDelayMs(latestActivityMs: number | undefined, now: number): number {
  const age = latestActivityMs === undefined ? Number.POSITIVE_INFINITY : now - latestActivityMs;
  if (age < 60 * 60_000) return 30_000;
  if (age < 6 * 60 * 60_000) return 2 * 60_000;
  return 10 * 60_000;
}

/** Newest activity in a channel's recent messages, replies included. */
export function slackLatestActivityMs(
  messages: ReadonlyArray<SlackApiMessage>,
): number | undefined {
  let latest: number | undefined;
  for (const message of messages) {
    for (const ts of [message.ts, message.latest_reply]) {
      if (ts === undefined) continue;
      const ms = slackTsToMs(ts);
      if (latest === undefined || ms > latest) latest = ms;
    }
  }
  return latest;
}

export function slackPermalink(teamUrl: string, channelId: string, ts: string): string {
  const base = teamUrl.endsWith("/") ? teamUrl : `${teamUrl}/`;
  return `${base}archives/${channelId}/p${ts.replace(".", "")}`;
}

/** Newest first, capped, across every channel. */
export function slackFeedOrder<T extends { readonly ts: string }>(
  threads: Iterable<T>,
  limit = SLACK_FEED_LIMIT,
): T[] {
  return [...threads]
    .sort((left, right) => Number.parseFloat(right.ts) - Number.parseFloat(left.ts))
    .slice(0, limit);
}
