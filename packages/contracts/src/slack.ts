/**
 * Slack - Schemas for the Job page's Slack connection.
 *
 * The environment server owns the Slack user token and polls the channels the
 * user belongs to. Clients only see the rendered feed: root messages (threads)
 * from the recent window, with authors, emoji, and mentions already resolved.
 *
 * Sign-in uses the user's own Slack app with PKCE and a loopback redirect, so
 * no client secret or public URL is needed. When the browser is not on the
 * server's machine the redirect cannot land, and the user pastes the final
 * URL back instead.
 *
 * @module Slack
 */
import { Effect, Schema } from "effect";

/** Registered in the Slack app manifest; Slack matches it exactly. */
export const SLACK_OAUTH_LOOPBACK_PORT = 38117;
export const SLACK_OAUTH_REDIRECT_URI = `http://localhost:${SLACK_OAUTH_LOOPBACK_PORT}/slack/callback`;

/**
 * Read channels, group messages, and direct messages, resolve people and custom emoji, and
 * read and write reactions. Direct messages are read only for followed threads.
 */
export const SLACK_USER_SCOPES = [
  "channels:read",
  "groups:read",
  "mpim:read",
  "im:read",
  "channels:history",
  "groups:history",
  "mpim:history",
  "im:history",
  "users:read",
  "emoji:read",
  "reactions:read",
  "reactions:write",
] as const;

/** The manifest the "Create Slack app" link prefills. */
export function slackAppManifest() {
  return {
    display_information: {
      name: "T3 Code",
      description: "Follow Slack threads from T3 Code.",
    },
    oauth_config: {
      redirect_urls: [SLACK_OAUTH_REDIRECT_URI],
      scopes: { user: [...SLACK_USER_SCOPES] },
      pkce_enabled: true,
    },
    settings: {
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

export function slackCreateAppUrl(): string {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(
    JSON.stringify(slackAppManifest()),
  )}`;
}

export const SlackChannelKind = Schema.Literals(["channel", "private", "group", "dm"]);
export type SlackChannelKind = typeof SlackChannelKind.Type;

export const SlackReaction = Schema.Struct({
  /** Slack's name, including any skin tone suffix; what reactions.add takes. */
  name: Schema.String,
  count: Schema.Number,
  reacted: Schema.Boolean,
  /** Standard emoji character, when known. */
  unicode: Schema.optional(Schema.String),
  /** Workspace custom emoji image. */
  imageUrl: Schema.optional(Schema.String),
});
export type SlackReaction = typeof SlackReaction.Type;

export const SlackMessage = Schema.Struct({
  channelId: Schema.String,
  ts: Schema.String,
  authorName: Schema.String,
  authorAvatarUrl: Schema.optional(Schema.String),
  /** Markdown converted from Slack mrkdwn, with mentions resolved. */
  markdown: Schema.String,
  fileCount: Schema.Number,
  edited: Schema.Boolean,
  replyCount: Schema.Number,
  latestReplyTs: Schema.optional(Schema.String),
  reactions: Schema.Array(SlackReaction),
});
export type SlackMessage = typeof SlackMessage.Type;

export const SlackThread = Schema.Struct({
  ...SlackMessage.fields,
  channelName: Schema.String,
  channelKind: SlackChannelKind,
  permalink: Schema.String,
});
export type SlackThread = typeof SlackThread.Type;

export const SlackConnection = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("disconnected"),
    /** The app last used, so reconnecting does not ask for it again. */
    clientId: Schema.optional(Schema.String),
    error: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    status: Schema.Literal("authorizing"),
    clientId: Schema.String,
    authorizeUrl: Schema.String,
    error: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    status: Schema.Literal("connected"),
    clientId: Schema.String,
    teamName: Schema.String,
    teamUrl: Schema.String,
    userId: Schema.String,
    userName: Schema.String,
  }),
]);
export type SlackConnection = typeof SlackConnection.Type;

export const SlackSync = Schema.Struct({
  channelCount: Schema.Number,
  /** Channels read at least once since connecting. */
  syncedChannelCount: Schema.Number,
  lastSyncedAt: Schema.optional(Schema.String),
  /** Background reads pause until then after Slack asks us to slow down. */
  rateLimitedUntil: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});
export type SlackSync = typeof SlackSync.Type;

export const SlackThreadRef = Schema.Struct({
  channelId: Schema.String,
  ts: Schema.String,
});
export type SlackThreadRef = typeof SlackThreadRef.Type;

export const SlackState = Schema.Struct({
  connection: SlackConnection,
  sync: SlackSync,
  /** Newest first, capped. */
  threads: Schema.Array(SlackThread),
  /**
   * Threads the user marked with :eyes:, anywhere in the workspace and however old, newest
   * first. Reading the reaction back from Slack makes the mark the only state to manage.
   */
  followed: Schema.Array(SlackThread).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /**
   * New threads the user dismissed from the Job page. Kept on the server so every device
   * agrees; the client hides them from the new list and offers them back under a toggle.
   */
  dismissed: Schema.Array(SlackThreadRef).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type SlackState = typeof SlackState.Type;

/** The reaction that marks a Slack thread as followed. */
export const SLACK_FOLLOW_REACTION = "eyes";

/** A workspace member who can own T3 threads. */
export const SlackMember = Schema.Struct({
  userId: Schema.String,
  name: Schema.String,
  avatarUrl: Schema.optional(Schema.String),
});
export type SlackMember = typeof SlackMember.Type;

/**
 * Who a T3 thread is for. Absent or null means the person running this environment, who
 * created it. A snapshot of the member so the sidebar renders without a live lookup.
 */
export const ThreadOwner = Schema.Struct({
  kind: Schema.Literal("slack"),
  userId: Schema.String,
  name: Schema.String,
  avatarUrl: Schema.optional(Schema.String),
});
export type ThreadOwner = typeof ThreadOwner.Type;

export const SlackConnectInput = Schema.Struct({
  clientId: Schema.String.check(Schema.isPattern(/^\d+\.\d+$/)),
});
export type SlackConnectInput = typeof SlackConnectInput.Type;

export const SlackCompleteConnectInput = Schema.Struct({
  /** The full URL Slack redirected to. */
  callbackUrl: Schema.String,
});
export type SlackCompleteConnectInput = typeof SlackCompleteConnectInput.Type;

export const SlackSetReactionInput = Schema.Struct({
  channelId: Schema.String,
  ts: Schema.String,
  name: Schema.String,
  reacted: Schema.Boolean,
});
export type SlackSetReactionInput = typeof SlackSetReactionInput.Type;

export const SlackSetDismissedInput = Schema.Struct({
  channelId: Schema.String,
  ts: Schema.String,
  dismissed: Schema.Boolean,
});
export type SlackSetDismissedInput = typeof SlackSetDismissedInput.Type;

export class SlackError extends Schema.TaggedError<SlackError>()("SlackError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

/** Parse a copied Slack message link, resolving reply links to their parent thread. */
export function parseSlackThreadUrl(value: string) {
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      !/^[a-z0-9-]+\.slack\.com$/i.test(url.hostname) ||
      url.username ||
      url.password ||
      url.port
    )
      return null;
    const match = /^\/archives\/([CDG][A-Z0-9]+)\/p(\d{10,})(\d{6})\/?$/.exec(url.pathname);
    if (!match) return null;
    const ts = url.searchParams.get("thread_ts") ?? `${match[2]}.${match[3]}`;
    if (!/^\d{10,}\.\d{6}$/.test(ts)) return null;
    return {
      channelId: match[1]!,
      ts,
      url: `https://${url.hostname}/archives/${match[1]}/p${ts.replace(".", "")}`,
    };
  } catch {
    return null;
  }
}

export const SlackThreadUrl = Schema.String.check(
  Schema.makeFilter(
    (value) => parseSlackThreadUrl(value) !== null || "Paste a Slack message or thread link.",
  ),
);
export const ThreadSlackLinks = Schema.Array(SlackThreadUrl).check(Schema.isMaxLength(20));
export const SlackGetThreadInput = Schema.Struct({ url: SlackThreadUrl });
export type SlackGetThreadInput = typeof SlackGetThreadInput.Type;
export const SlackThreadDetail = Schema.Struct({
  thread: SlackThread,
  replies: Schema.Array(SlackMessage),
  hasMore: Schema.Boolean,
});
export type SlackThreadDetail = typeof SlackThreadDetail.Type;
