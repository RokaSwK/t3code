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

import { PullRequestState } from "./pullRequest.ts";

/** Registered in the Slack app manifest; Slack matches it exactly. */
export const SLACK_OAUTH_LOOPBACK_PORT = 38117;
export const SLACK_OAUTH_REDIRECT_URI = `http://localhost:${SLACK_OAUTH_LOOPBACK_PORT}/slack/callback`;

/**
 * Read channels, group messages, and direct messages, resolve people and custom emoji, read and
 * write reactions, search for Devin's messages, and post the replies you send from a draft.
 * Direct messages are read only for threads that are yours.
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
  "search:read",
  "chat:write",
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

export const SlackChannel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: SlackChannelKind,
});
export type SlackChannel = typeof SlackChannel.Type;

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

/** A GitHub pull request linked from a thread, or from any message in one of your conversations. */
export const SlackPullRequest = Schema.Struct({
  url: Schema.String,
  /** `owner/name`. */
  repository: Schema.String,
  number: Schema.Number,
  /** Absent until GitHub answers, or when the PR cannot be read. */
  state: Schema.optional(PullRequestState),
});
export type SlackPullRequest = typeof SlackPullRequest.Type;

/** Who wrote the newest reply in a conversation. Devin is an agent, not a person waiting. */
export const SlackReplyAuthor = Schema.Literals(["me", "devin", "other"]);
export type SlackReplyAuthor = typeof SlackReplyAuthor.Type;

/** A Devin session's state, from Devin's API. */
export const DevinSessionState = Schema.Literals([
  "working",
  "waiting",
  "finished",
  "suspended",
  "error",
]);
export type DevinSessionState = typeof DevinSessionState.Type;

/** A Devin session working in a Slack conversation, found from its session links. */
export const SlackDevinSession = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  /** Absent without a Devin API key, or until Devin answers. */
  state: Schema.optional(DevinSessionState),
  title: Schema.optional(Schema.String),
});
export type SlackDevinSession = typeof SlackDevinSession.Type;

/** An open pull request in the user's GitHub queue, with what it is waiting on. */
export const WorkGitHubPullRequest = Schema.Struct({
  url: Schema.String,
  repository: Schema.String,
  number: Schema.Number,
  title: Schema.String,
  isDraft: Schema.Boolean,
  updatedAt: Schema.String,
  author: Schema.optional(Schema.String),
  authorAvatarUrl: Schema.optional(Schema.String),
  review: Schema.optional(Schema.Literals(["approved", "changes-requested", "review-required"])),
  checks: Schema.optional(Schema.Literals(["passing", "failing", "pending"])),
  conflicting: Schema.optional(Schema.Boolean),
});
export type WorkGitHubPullRequest = typeof WorkGitHubPullRequest.Type;

export const SlackThread = Schema.Struct({
  ...SlackMessage.fields,
  channelName: Schema.String,
  channelKind: SlackChannelKind,
  permalink: Schema.String,
  pullRequests: Schema.optional(Schema.Array(SlackPullRequest)),
  /** The rest is read for your conversations only; feed threads leave it out. */
  startedByMe: Schema.optional(Schema.Boolean),
  /** You reacted with the follow reaction. */
  followed: Schema.optional(Schema.Boolean),
  lastReply: Schema.optional(
    Schema.Struct({ by: SlackReplyAuthor, authorName: Schema.String, ts: Schema.String }),
  ),
  devin: Schema.optional(
    Schema.Struct({
      sessions: Schema.Array(SlackDevinSession),
      /** Devin's newest message says the session stopped until tagged again. */
      stopped: Schema.Boolean,
      lastMessageTs: Schema.String,
    }),
  ),
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
    /** Signing in again while connected; the feed keeps running meanwhile. */
    connectedAs: Schema.optional(
      Schema.Struct({ teamName: Schema.String, userName: Schema.String }),
    ),
  }),
  Schema.Struct({
    status: Schema.Literal("connected"),
    clientId: Schema.String,
    teamName: Schema.String,
    teamUrl: Schema.String,
    userId: Schema.String,
    userName: Schema.String,
    /** Permissions this sign-in lacks; signing in again grants them. */
    missingScopes: Schema.optional(Schema.Array(Schema.String)),
  }),
]);
export type SlackConnection = typeof SlackConnection.Type;

export const SlackSync = Schema.Struct({
  channelCount: Schema.Number,
  availableChannelCount: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
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

export const SlackDismissedThread = Schema.Struct({
  ...SlackThreadRef.fields,
  /** When it was marked done, in ms; a later reply from someone else reopens it. */
  at: Schema.optional(Schema.Number),
});
export type SlackDismissedThread = typeof SlackDismissedThread.Type;

/** The Devin API key on this server. The key itself never leaves the server. */
export const DevinConnection = Schema.Union([
  Schema.Struct({ status: Schema.Literal("disconnected"), error: Schema.optional(Schema.String) }),
  Schema.Struct({
    status: Schema.Literal("connected"),
    name: Schema.String,
    orgId: Schema.String,
    error: Schema.optional(Schema.String),
  }),
]);
export type DevinConnection = typeof DevinConnection.Type;

export const SlackState = Schema.Struct({
  connection: SlackConnection,
  sync: SlackSync,
  /** Newest first, capped. */
  threads: Schema.Array(SlackThread),
  /**
   * Your conversations, newest activity first: threads you marked with :eyes: anywhere in the
   * workspace, and Devin threads you started or wrote in. Both are read back from Slack, so
   * the reaction and the messages are the only state to manage.
   */
  conversations: Schema.Array(SlackThread).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /**
   * Threads the user marked done on the Work page. Kept on the server so every device agrees.
   */
  dismissed: Schema.Array(SlackDismissedThread).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Exclusions apply to the new-thread feed, while followed threads remain available. */
  excludedChannelIds: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /**
   * Conversations handed to someone else. They stay on the Work page to watch, apart from the
   * ones that are yours to act on.
   */
  conversationOwners: Schema.Array(
    Schema.Struct({
      channelId: Schema.String,
      ts: Schema.String,
      userId: Schema.String,
      name: Schema.String,
      avatarUrl: Schema.optional(Schema.String),
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /**
   * Conversations that are yours but blocked on someone, such as a reviewer. They wait until
   * someone else replies after `at` (ms).
   */
  conversationWaits: Schema.Array(
    Schema.Struct({
      channelId: Schema.String,
      ts: Schema.String,
      userId: Schema.String,
      name: Schema.String,
      avatarUrl: Schema.optional(Schema.String),
      at: Schema.Number,
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Open pull requests waiting for the user's review, from GitHub. */
  reviewRequests: Schema.Array(WorkGitHubPullRequest).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** The user's own open pull requests, from GitHub. */
  authoredPullRequests: Schema.Array(WorkGitHubPullRequest).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Replies saved to send in a conversation, by the user or drafted by the Work agent. */
  replyDrafts: Schema.Array(
    Schema.Struct({
      channelId: Schema.String,
      ts: Schema.String,
      text: Schema.String,
      by: Schema.Literals(["you", "agent"]),
      at: Schema.Number,
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Devin's logo, from its Slack profile, for marking its sessions. */
  devinAvatarUrl: Schema.optional(Schema.String),
  devin: DevinConnection.pipe(
    Schema.withDecodingDefault(Effect.succeed({ status: "disconnected" as const })),
  ),
});
export type SlackState = typeof SlackState.Type;

/** The reaction that marks a Slack thread as followed. */
export const SLACK_FOLLOW_REACTION = "eyes";

/** Anyone reacting with a tick to a thread's root marks the conversation done. */
export const SLACK_DONE_REACTIONS: ReadonlySet<string> = new Set([
  "white_check_mark",
  "heavy_check_mark",
  "ballot_box_with_check",
]);

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

export const DevinConnectInput = Schema.Struct({
  apiKey: Schema.String.check(Schema.isMinLength(8)),
});
export type DevinConnectInput = typeof DevinConnectInput.Type;

/** Hands a conversation to a workspace member, or back to you with `owner: null`. */
export const SlackSetConversationOwnerInput = Schema.Struct({
  channelId: Schema.String,
  ts: Schema.String,
  owner: Schema.NullOr(
    Schema.Struct({
      userId: Schema.String,
      name: Schema.String,
      avatarUrl: Schema.optional(Schema.String),
    }),
  ),
});
export type SlackSetConversationOwnerInput = typeof SlackSetConversationOwnerInput.Type;

/** Marks a conversation as waiting on a workspace member, or clears it with `member: null`. */
export const SlackSetConversationWaitInput = Schema.Struct({
  channelId: Schema.String,
  ts: Schema.String,
  member: Schema.NullOr(
    Schema.Struct({
      userId: Schema.String,
      name: Schema.String,
      avatarUrl: Schema.optional(Schema.String),
    }),
  ),
});
export type SlackSetConversationWaitInput = typeof SlackSetConversationWaitInput.Type;

/** Saves a reply to send later, or clears it with `text: null`. */
export const SlackSetReplyDraftInput = Schema.Struct({
  channelId: Schema.String,
  ts: Schema.String,
  text: Schema.NullOr(Schema.String),
});
export type SlackSetReplyDraftInput = typeof SlackSetReplyDraftInput.Type;

/** Posts a reply in the conversation as the user, and clears its draft. */
export const SlackSendReplyInput = Schema.Struct({
  channelId: Schema.String,
  ts: Schema.String,
  text: Schema.String.check(Schema.isMinLength(1)),
});
export type SlackSendReplyInput = typeof SlackSendReplyInput.Type;

export const SlackSetChannelExcludedInput = Schema.Struct({
  channelId: Schema.String,
  excluded: Schema.Boolean,
});
export type SlackSetChannelExcludedInput = typeof SlackSetChannelExcludedInput.Type;

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
