/**
 * Pure rules for "mentions you haven't answered": messages that tag you, found through Slack
 * search, minus the ones you replied after or reacted to. Kept apart from the service so they
 * can be tested without Slack.
 */
import { type SlackApiSearchMatch, slackSearchMatchThread } from "./slackConversations.ts";

/** Mentions are looked for this far back. */
export const SLACK_MENTION_WINDOW_MS = 14 * 24 * 60 * 60_000;
export const SLACK_MENTION_INTERVAL_MS = 2 * 60_000;
export const SLACK_MENTION_FIRST_DELAY_MS = 20_000;
export const SLACK_MENTION_MAX_PAGES = 3;
/** Your own messages run longer than mentions of you; each page is one rate-limited search. */
export const SLACK_MENTION_MINE_MAX_PAGES = 5;
/** Unanswered mentions listed, newest first; one per conversation. */
export const SLACK_MENTION_LIMIT = 30;

/** A message found by search: where it lives and who wrote it. */
export interface SlackMentionHit {
  readonly channelId: string;
  /** The conversation root; the message itself when it is not a reply. */
  readonly ts: string;
  readonly messageTs: string;
  readonly userId?: string;
  /** A direct or group message, where answering does not need a thread. */
  readonly direct: boolean;
  readonly text: string;
  readonly permalink: string;
}

/** A `search.messages` match with what a mention needs. */
export interface SlackApiMentionMatch extends SlackApiSearchMatch {
  readonly user?: string;
  readonly text?: string;
  readonly channel?: SlackApiSearchMatch["channel"] & {
    readonly is_im?: boolean;
    readonly is_mpim?: boolean;
  };
}

export function slackMentionHit(match: SlackApiMentionMatch): SlackMentionHit | undefined {
  const ref = slackSearchMatchThread(match);
  if (!ref || !match.permalink) return undefined;
  return {
    ...ref,
    ...(match.user ? { userId: match.user } : {}),
    direct: match.channel?.is_im === true || match.channel?.is_mpim === true,
    text: match.text ?? "",
    permalink: match.permalink,
  };
}

const later = (left: string, right: string) => Number.parseFloat(left) > Number.parseFloat(right);

/**
 * The newest mention in each conversation that you have not answered, newest first. You
 * answered it by writing later in the same conversation (or, in a direct message, anywhere
 * later in it) or by reacting to the mention. Mentions by apps and by you don't count.
 * `mineSince` is the oldest of your messages read; older mentions can't be judged, so they
 * are left out rather than shown as unanswered.
 */
export function unansweredSlackMentions(input: {
  readonly mentions: ReadonlyArray<SlackMentionHit>;
  readonly mine: ReadonlyArray<SlackMentionHit>;
  /** `channel:ts` of messages you reacted to. */
  readonly reacted: ReadonlySet<string>;
  readonly me: string;
  readonly mineSince?: string | undefined;
  readonly limit?: number;
}): SlackMentionHit[] {
  const newestMine = new Map<string, string>();
  const note = (key: string, ts: string) => {
    const previous = newestMine.get(key);
    if (!previous || later(ts, previous)) newestMine.set(key, ts);
  };
  for (const message of input.mine) {
    note(`${message.channelId}:${message.ts}`, message.messageTs);
    if (message.direct) note(message.channelId, message.messageTs);
  }
  const byConversation = new Map<string, SlackMentionHit>();
  for (const mention of input.mentions) {
    if (!mention.userId || mention.userId === input.me) continue;
    if (input.mineSince && !later(mention.messageTs, input.mineSince)) continue;
    if (input.reacted.has(`${mention.channelId}:${mention.messageTs}`)) continue;
    const key = `${mention.channelId}:${mention.ts}`;
    const answeredAt = [
      newestMine.get(key),
      mention.direct ? newestMine.get(mention.channelId) : undefined,
    ];
    if (answeredAt.some((ts) => ts !== undefined && later(ts, mention.messageTs))) continue;
    const previous = byConversation.get(key);
    if (!previous || later(mention.messageTs, previous.messageTs)) byConversation.set(key, mention);
  }
  return [...byConversation.values()]
    .sort((left, right) => Number.parseFloat(right.messageTs) - Number.parseFloat(left.messageTs))
    .slice(0, input.limit ?? SLACK_MENTION_LIMIT);
}
