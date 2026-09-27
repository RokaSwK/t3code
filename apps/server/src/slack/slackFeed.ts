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

/** Followed threads are read back from the user's reactions this often. */
export const SLACK_FOLLOWED_INTERVAL_MS = 2 * 60_000;
export const SLACK_FOLLOWED_LIMIT = 50;

/** An entry of `reactions.list`; only message items matter here. */
export interface SlackApiReactionItem {
  readonly type: string;
  readonly channel?: string;
  readonly message?: SlackApiMessage;
}

export interface SlackFollowedRef {
  readonly channelId: string;
  /** The conversation root; a followed reply follows its parent. */
  readonly ts: string;
  /** Known when the followed message is the root itself. */
  readonly root?: SlackApiMessage;
}

/**
 * The conversations the user marked with `reaction`, newest first and deduplicated. Slack
 * lists every item the user reacted to, so the reaction is checked on each message.
 */
export function slackFollowedRefs(
  items: ReadonlyArray<SlackApiReactionItem>,
  userId: string,
  reaction: string,
  limit = SLACK_FOLLOWED_LIMIT,
): SlackFollowedRef[] {
  const refs = new Map<string, SlackFollowedRef>();
  for (const item of items) {
    const message = item.message;
    if (item.type !== "message" || !item.channel || !message) continue;
    const marked = message.reactions?.some(
      (candidate) => candidate.name === reaction && (candidate.users ?? []).includes(userId),
    );
    if (!marked) continue;
    const ts = message.thread_ts ?? message.ts;
    const key = `${item.channel}:${ts}`;
    const existing = refs.get(key);
    const isRoot = ts === message.ts;
    if (existing && (existing.root || !isRoot)) continue;
    refs.set(key, { channelId: item.channel, ts, ...(isRoot ? { root: message } : {}) });
  }
  return slackFeedOrder(refs.values(), limit);
}

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

/** Open PRs linked from the feed are re-read this often; merged and closed ones are final. */
export const SLACK_PULL_REQUEST_INTERVAL_MS = 5 * 60_000;
/** Aliases per GitHub GraphQL request. */
export const SLACK_PULL_REQUEST_BATCH = 50;
const PULL_REQUESTS_PER_THREAD = 5;

export interface SlackPullRequestLink {
  readonly url: string;
  readonly repository: string;
  readonly number: number;
}

const GITHUB_PULL_REQUEST_URL =
  /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/g;

/** github.com pull requests a message links to, deduplicated, in order of appearance. */
export function slackPullRequestLinks(text: string): SlackPullRequestLink[] {
  const links = new Map<string, SlackPullRequestLink>();
  for (const match of text.matchAll(GITHUB_PULL_REQUEST_URL)) {
    const repository = `${match[1]}/${match[2]}`;
    const number = Number(match[3]);
    const url = `https://github.com/${repository}/pull/${number}`;
    if (!links.has(url)) links.set(url, { url, repository, number });
    if (links.size === PULL_REQUESTS_PER_THREAD) break;
  }
  return [...links.values()];
}

/** One GraphQL document reading every PR's state by URL; `resource` needs no repository lookup. */
export function slackPullRequestStateQuery(urls: ReadonlyArray<string>): string {
  const fields = urls.map(
    (url, index) =>
      `p${index}: resource(url: ${JSON.stringify(url)}) { ... on PullRequest { state } }`,
  );
  return `query { ${fields.join(" ")} }`;
}

/** The states GitHub answered for `urls`, keyed by URL. PRs it could not read are left out. */
export function slackPullRequestStates(
  urls: ReadonlyArray<string>,
  response: unknown,
): Map<string, "open" | "closed" | "merged"> {
  const data = (response as { data?: Record<string, { state?: unknown } | null> } | null)?.data;
  const states = new Map<string, "open" | "closed" | "merged">();
  for (const [index, url] of urls.entries()) {
    const state = data?.[`p${index}`]?.state;
    if (state === "OPEN") states.set(url, "open");
    else if (state === "CLOSED") states.set(url, "closed");
    else if (state === "MERGED") states.set(url, "merged");
  }
  return states;
}
