/**
 * SlackService - the environment's Slack connection and thread feed.
 *
 * Sign-in is OAuth v2 with PKCE against the user's own Slack app, so there is
 * no client secret to keep. Slack redirects to a loopback listener that only
 * runs while an authorization is pending; a browser on another machine cannot
 * reach it, so the redirect URL can also be pasted back through
 * `completeConnect`.
 *
 * The user token lives in the secret store. While connected, one fiber reads
 * the user's channels on an activity-based schedule through
 * {@link SlackRateLimiter}, and the feed is published as a whole snapshot,
 * throttled, because it is capped and small.
 *
 * The same fiber keeps "your conversations": threads you marked with :eyes:
 * (read back from your reactions) and Devin threads you started or wrote in
 * (found by searching Devin's messages). Each is read whole on its own
 * activity-based schedule. With a Devin API key, the sessions Devin links from
 * those threads get their state from Devin.
 *
 * @module SlackService
 */
// @effect-diagnostics nodeBuiltinImport:off - the sign-in loopback listens on a Node HTTP server.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  DevinSessionState,
  PullRequestState,
  WorkGitHubPullRequest,
  SlackChannelKind,
  type DevinConnectInput,
  type DevinConnection,
  type SlackDevinSession,
  type SlackDismissedThread,
  SlackDismissedThread as SlackDismissedThreadSchema,
  SLACK_FOLLOW_REACTION,
  SLACK_OAUTH_REDIRECT_URI,
  SLACK_OAUTH_LOOPBACK_PORT,
  SLACK_USER_SCOPES,
  SlackError,
  parseSlackThreadUrl,
  type SlackGetThreadInput,
  type SlackThreadDetail,
  type SlackCompleteConnectInput,
  type SlackConnectInput,
  type SlackConnection,
  type SlackMember,
  SlackMention,
  type SlackMessage,
  type SlackReaction,
  type SlackSetReactionInput,
  type SlackSetDismissedInput,
  type SlackSetChannelIncludedInput,
  type SlackSetConversationOwnerInput,
  type SlackSetConversationWaitInput,
  type SlackSetReplyDraftInput,
  type SlackSendReplyInput,
  type SlackSetAppTokenInput,
  type SlackEvents,
  type SlackChannel,
  type SlackPullRequest,
  type SlackState,
  SlackThread,
  type SlackThreadRef,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Socket from "effect/unstable/socket/Socket";

import * as NodeSocket from "@effect/platform-node/NodeSocket";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import { slackImages } from "./slackImages.ts";
import { slackImageResponse } from "./SlackImageFetch.ts";
import {
  isSlackThreadRoot,
  SLACK_CHANNEL_LIST_INTERVAL_MS,
  SLACK_FEED_WINDOW_MS,
  SLACK_FOLLOWED_INTERVAL_MS,
  SLACK_PULL_REQUEST_BATCH,
  SLACK_PULL_REQUEST_INTERVAL_MS,
  slackFeedOrder,
  slackFollowedRefs,
  type SlackApiReactionItem,
  slackLatestActivityMs,
  slackPermalink,
  slackPollDelayMs,
  slackPullRequestLinks,
  slackPullRequestStateQuery,
  slackTsToMs,
  slackPullRequestStates,
  type SlackApiMessage,
} from "./slackFeed.ts";
import {
  DEVIN_SEARCH_INTERVAL_MS,
  DEVIN_SEARCH_MAX_PAGES,
  DEVIN_SEARCH_WINDOW_MS,
  type DevinIdentity,
  devinSessionRecheckMs,
  devinSessionState,
  devinSessionUrl,
  findDevinUser,
  type SlackApiSearchMatch,
  slackConversationDelayMs,
  slackConversationPullRequests,
  slackSearchAfterDate,
  slackSearchMatchThread,
  summarizeSlackConversation,
} from "./slackConversations.ts";
import {
  SLACK_MENTION_FIRST_DELAY_MS,
  SLACK_MENTION_INTERVAL_MS,
  SLACK_MENTION_MAX_PAGES,
  SLACK_MENTION_MINE_MAX_PAGES,
  SLACK_MENTION_WINDOW_MS,
  type SlackApiMentionMatch,
  slackMentionHit,
  type SlackMentionHit,
  unansweredSlackMentions,
} from "./slackMentions.ts";
import {
  SLACK_EVENT_DEBOUNCE_MS,
  SLACK_EVENT_SEARCH_DELAY_MS,
  SLACK_EVENTS_RECONCILE_MS,
  type SlackApiEvent,
  slackEventTarget,
  slackSocketErrorIsFinal,
} from "./slackEvents.ts";
import { runSlackSocket } from "./SlackSocket.ts";
import { GITHUB_QUEUE_INTERVAL_MS, githubQueueQuery, parseGitHubQueue } from "./githubQueue.ts";
import { slackMentionedUserIds, slackMrkdwnToMarkdown, standardEmoji } from "./slackMrkdwn.ts";
import { SlackRateLimiter, type SlackCallPriority } from "./slackRateLimiter.ts";

const CONNECTION_SECRET = "slack-connection";
/** The app last signed in with, kept across sign-outs so reconnecting is one click. */
const CLIENT_ID_SECRET = "slack-client-id";
const DISMISSED_SECRET = "slack-dismissed-threads";
const OWNERS_SECRET = "slack-conversation-owners";
const WAITS_SECRET = "slack-conversation-waits";
const DRAFTS_SECRET = "slack-reply-drafts";
const INCLUDED_CHANNELS_SECRET = "slack-included-channels";
const INBOX_START_SECRET = "slack-inbox-start";
/** `{ apiKey, orgId, name }` for Devin's API. */
const DEVIN_SECRET = "devin-api";
/** The Slack app-level token (`xapp-…`) that opens Socket Mode connections. */
const APP_TOKEN_SECRET = "slack-app-token";
/** Marked-done threads are remembered this long after being marked. */
const DISMISSED_RETENTION_MS = 30 * 24 * 60 * 60_000;
const CONVERSATIONS_LIMIT = 100;
/** Devin session states are read this often, a few at a time. */
const DEVIN_SESSIONS_INTERVAL_MS = 30_000;
const DEVIN_SESSIONS_PER_PASS = 10;
/**
 * What was read from Slack, so a restart shows the page at once and only reads what changed.
 * Kept with the other Slack secrets because it holds message text.
 */
const CACHE_SECRET = "slack-cache";
const CACHE_SAVE_INTERVAL_MS = 30_000;
const AUTHORIZATION_TIMEOUT = Duration.minutes(10);
/** Snapshots go out at most this often while channels sync. */
const PUBLISH_INTERVAL_MS = 2_000;
/** A click should fail fast rather than hang behind a long Slack pause. */
const INTERACTIVE_MAX_WAIT_MS = 10_000;
/** The member directory changes rarely; the owner picker reuses it this long. */
const MEMBERS_TTL_MS = 10 * 60_000;
const MEMBERS_MAX_PAGES = 5;
// A missing scope is not in this set on purpose: a token from before a scope was added still
// works for everything else, and one refused call must not end the sign-in.
const AUTH_ERRORS = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "account_inactive",
]);

const StoredConnection = Schema.Struct({
  clientId: Schema.String,
  accessToken: Schema.String,
  refreshToken: Schema.optional(Schema.String),
  expiresAtMs: Schema.optional(Schema.Number),
  teamName: Schema.String,
  teamUrl: Schema.String,
  userId: Schema.String,
  userName: Schema.String,
});
const StoredInboxStart = Schema.Struct({
  teamUrl: Schema.String,
  userId: Schema.String,
  startedAtMs: Schema.Number,
});
const decodeStoredInboxStart = Schema.decodeUnknownOption(Schema.fromJsonString(StoredInboxStart));
const encodeStoredInboxStart = Schema.encodeSync(Schema.fromJsonString(StoredInboxStart));
type StoredConnection = typeof StoredConnection.Type;
const decodeStoredConnection = Schema.decodeUnknownOption(Schema.fromJsonString(StoredConnection));
const encodeStoredConnection = Schema.encodeSync(Schema.fromJsonString(StoredConnection));
const StoredDismissed = Schema.Struct({
  teamUrl: Schema.String,
  userId: Schema.String,
  threads: Schema.Array(SlackDismissedThreadSchema),
});
const decodeStoredDismissed = Schema.decodeUnknownOption(Schema.fromJsonString(StoredDismissed));
const encodeStoredDismissed = Schema.encodeSync(Schema.fromJsonString(StoredDismissed));
const ConversationOwner = Schema.Struct({
  channelId: Schema.String,
  ts: Schema.String,
  userId: Schema.String,
  name: Schema.String,
  avatarUrl: Schema.optional(Schema.String),
});
type ConversationOwner = typeof ConversationOwner.Type;
const StoredOwners = Schema.Struct({
  teamUrl: Schema.String,
  userId: Schema.String,
  owners: Schema.Array(ConversationOwner),
});
const decodeStoredOwners = Schema.decodeUnknownOption(Schema.fromJsonString(StoredOwners));
const encodeStoredOwners = Schema.encodeSync(Schema.fromJsonString(StoredOwners));

const ConversationWait = Schema.Struct({
  ...ConversationOwner.fields,
  at: Schema.Number,
});
type ConversationWait = typeof ConversationWait.Type;
const StoredWaits = Schema.Struct({
  teamUrl: Schema.String,
  userId: Schema.String,
  waits: Schema.Array(ConversationWait),
});
const decodeStoredWaits = Schema.decodeUnknownOption(Schema.fromJsonString(StoredWaits));
const encodeStoredWaits = Schema.encodeSync(Schema.fromJsonString(StoredWaits));

const ReplyDraft = Schema.Struct({
  channelId: Schema.String,
  ts: Schema.String,
  text: Schema.String,
  by: Schema.Literals(["you", "agent"]),
  at: Schema.Number,
});
type ReplyDraft = typeof ReplyDraft.Type;
const StoredDrafts = Schema.Struct({
  teamUrl: Schema.String,
  userId: Schema.String,
  drafts: Schema.Array(ReplyDraft),
});
const decodeStoredDrafts = Schema.decodeUnknownOption(Schema.fromJsonString(StoredDrafts));
const encodeStoredDrafts = Schema.encodeSync(Schema.fromJsonString(StoredDrafts));

const StoredIncludedChannels = Schema.Struct({
  teamUrl: Schema.String,
  userId: Schema.String,
  channelIds: Schema.Array(Schema.String),
});
const decodeStoredIncludedChannels = Schema.decodeUnknownOption(
  Schema.fromJsonString(StoredIncludedChannels),
);
const encodeStoredIncludedChannels = Schema.encodeSync(
  Schema.fromJsonString(StoredIncludedChannels),
);

const StoredDevin = Schema.Struct({
  apiKey: Schema.String,
  orgId: Schema.String,
  name: Schema.String,
});
type StoredDevin = typeof StoredDevin.Type;
const decodeStoredDevin = Schema.decodeUnknownOption(Schema.fromJsonString(StoredDevin));
const encodeStoredDevin = Schema.encodeSync(Schema.fromJsonString(StoredDevin));

const StoredCache = Schema.Struct({
  version: Schema.Literal(1),
  teamUrl: Schema.String,
  userId: Schema.String,
  savedAt: Schema.Number,
  channels: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      kind: SlackChannelKind,
      threads: Schema.Array(SlackThread),
    }),
  ),
  conversations: Schema.Array(
    Schema.Struct({
      channelId: Schema.String,
      ts: Schema.String,
      followed: Schema.Boolean,
      devin: Schema.Boolean,
      mine: Schema.Boolean,
      thread: Schema.optional(SlackThread),
      latestTs: Schema.optional(Schema.String),
    }),
  ),
  users: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      avatarUrl: Schema.optional(Schema.String),
    }),
  ),
  followedChannels: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String, kind: SlackChannelKind }),
  ),
  devinUser: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        userId: Schema.String,
        botId: Schema.optionalKey(Schema.String),
        avatarUrl: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  devinSeenTs: Schema.optional(Schema.String),
  pullRequests: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      state: Schema.optional(PullRequestState),
      checkedAt: Schema.Number,
    }),
  ),
  reviewRequests: Schema.optional(Schema.Array(WorkGitHubPullRequest)),
  authoredPullRequests: Schema.optional(Schema.Array(WorkGitHubPullRequest)),
  mergedPullRequests: Schema.optional(Schema.Array(WorkGitHubPullRequest)),
  devinSessions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      state: Schema.optional(DevinSessionState),
      title: Schema.optional(Schema.String),
      pullRequestUrls: Schema.Array(Schema.String),
      checkedAt: Schema.Number,
    }),
  ),
});
type StoredCache = typeof StoredCache.Type;
const decodeStoredCache = Schema.decodeUnknownOption(Schema.fromJsonString(StoredCache));
const encodeStoredCache = Schema.encodeSync(Schema.fromJsonString(StoredCache));

/** Every Slack Web API response; method-specific fields are read where used. */
interface SlackResponse {
  readonly ok: boolean;
  readonly error?: string;
  readonly [key: string]: unknown;
}

interface SlackApiChannel {
  readonly id: string;
  readonly name?: string;
  readonly is_private?: boolean;
  readonly is_mpim?: boolean;
  readonly is_im?: boolean;
  /** The other person, for direct messages. */
  readonly user?: string;
}

interface SlackApiUser {
  readonly id: string;
  readonly name?: string;
  readonly real_name?: string;
  readonly deleted?: boolean;
  readonly is_bot?: boolean;
  readonly is_app_user?: boolean;
  readonly profile?: {
    readonly display_name?: string;
    readonly real_name?: string;
    readonly image_48?: string;
    readonly bot_id?: string;
    readonly api_app_id?: string;
  };
}

interface ChannelState {
  readonly id: string;
  name: string;
  kind: SlackChannelKind;
  nextPollAt: number;
  synced: boolean;
  threads: ReadonlyArray<SlackThread>;
}

/** One of your conversations, or a Devin thread still to be checked for you. */
interface ConversationEntry {
  readonly channelId: string;
  readonly ts: string;
  /** You reacted with the follow reaction. */
  followed: boolean;
  /** Devin wrote in it; it is yours once a read shows you started it or wrote in it. */
  devin: boolean;
  mine: boolean;
  /** As last read, before PR and Devin session states are added. */
  thread?: SlackThread;
  /** Newest message at the last read. */
  latestTs?: string;
  nextReadAt: number;
}

const conversationKey = (ref: { readonly channelId: string; readonly ts: string }) =>
  `${ref.channelId}:${ref.ts}`;

const isVisibleConversation = (entry: ConversationEntry) =>
  entry.thread !== undefined && (entry.followed || (entry.devin && entry.mine));

/** A reaction toggled by the user, applied before Slack is read again. */
function patchReaction(
  reactions: ReadonlyArray<SlackReaction>,
  name: string,
  reacted: boolean,
  added?: () => SlackReaction,
): ReadonlyArray<SlackReaction> {
  const existing = reactions.find((reaction) => reaction.name === name);
  if (!existing) return reacted && added ? [...reactions, added()] : reactions;
  return reactions
    .map((reaction) =>
      reaction.name === name && reaction.reacted !== reacted
        ? { ...reaction, reacted, count: reaction.count + (reacted ? 1 : -1) }
        : reaction,
    )
    .filter((reaction) => reaction.count > 0);
}

interface PendingAuthorization {
  readonly clientId: string;
  readonly state: string;
  readonly verifier: string;
  readonly authorizeUrl: string;
  readonly scope: Scope.Closeable;
}

export class SlackService extends Context.Service<
  SlackService,
  {
    /** The current state followed by every change. */
    readonly state: Stream.Stream<SlackState>;
    /** The state as it is now, for server-side readers such as the Work tools. */
    readonly current: Effect.Effect<SlackState>;
    readonly connect: (input: SlackConnectInput) => Effect.Effect<SlackConnection, SlackError>;
    readonly completeConnect: (
      input: SlackCompleteConnectInput,
    ) => Effect.Effect<SlackConnection, SlackError>;
    readonly cancelConnect: Effect.Effect<void>;
    readonly disconnect: Effect.Effect<void>;
    readonly refresh: Effect.Effect<void>;
    readonly resetInbox: Effect.Effect<void, SlackError>;
    readonly getThread: (
      input: SlackGetThreadInput,
    ) => Effect.Effect<SlackThreadDetail, SlackError>;
    readonly getReplies: (
      ref: SlackThreadRef,
    ) => Effect.Effect<ReadonlyArray<SlackMessage>, SlackError>;
    readonly imageResponse: (
      url: string,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, SlackError, Scope.Scope>;
    readonly setReaction: (input: SlackSetReactionInput) => Effect.Effect<void, SlackError>;
    readonly unfollow: (ref: SlackThreadRef) => Effect.Effect<void, SlackError>;
    readonly setDismissed: (input: SlackSetDismissedInput) => Effect.Effect<void, SlackError>;
    readonly setConversationOwner: (
      input: SlackSetConversationOwnerInput,
    ) => Effect.Effect<void, SlackError>;
    readonly setConversationWait: (
      input: SlackSetConversationWaitInput,
    ) => Effect.Effect<void, SlackError>;
    /** Saves or clears a reply draft; the Work agent's are marked as its own. */
    readonly setReplyDraft: (
      input: SlackSetReplyDraftInput & { readonly by: "you" | "agent" },
    ) => Effect.Effect<void, SlackError>;
    /** Posts a reply in the conversation as the user and clears its draft. */
    readonly sendReply: (input: SlackSendReplyInput) => Effect.Effect<void, SlackError>;
    readonly getChannels: Effect.Effect<ReadonlyArray<SlackChannel>, SlackError>;
    readonly setChannelIncluded: (
      input: SlackSetChannelIncludedInput,
    ) => Effect.Effect<void, SlackError>;
    /** Workspace members, cached; who a T3 thread can be assigned to. */
    readonly listMembers: Effect.Effect<ReadonlyArray<SlackMember>, SlackError>;
    /** Saves or removes the app-level token for live events over Socket Mode. */
    readonly setAppToken: (input: SlackSetAppTokenInput) => Effect.Effect<void, SlackError>;
    readonly devinConnect: (input: DevinConnectInput) => Effect.Effect<DevinConnection, SlackError>;
    readonly devinDisconnect: Effect.Effect<void>;
  }
>()("t3/slack/SlackService") {}

const isSlackError = Schema.is(SlackError);
const isoTime = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const slackError = (operation: string, message: string) => new SlackError({ operation, message });

/** Group DMs arrive as `mpdm-ada--bo--cy-1`; show the people instead. */
function channelDisplayName(channel: SlackApiChannel): string {
  const name = channel.name ?? channel.id;
  if (!channel.is_mpim) return name;
  return name
    .replace(/^mpdm-/, "")
    .replace(/-\d+$/, "")
    .split("--")
    .join(", ");
}

function channelKind(channel: SlackApiChannel): SlackChannelKind {
  if (channel.is_im) return "dm";
  if (channel.is_mpim) return "group";
  return channel.is_private ? "private" : "channel";
}

function isMember(user: SlackApiUser): boolean {
  return !user.deleted && !user.is_bot && !user.is_app_user && user.id !== "USLACKBOT";
}

function userDisplayName(user: SlackApiUser): string {
  return (
    user.profile?.display_name || user.profile?.real_name || user.real_name || user.name || user.id
  );
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const encodeThreads = Schema.encodeSync(Schema.fromJsonString(Schema.Array(SlackThread)));
const encodePullRequests = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(WorkGitHubPullRequest)),
);
const encodeMentions = Schema.encodeSync(Schema.fromJsonString(Schema.Array(SlackMention)));
/** Reads mostly return what we already have; only a real change is published. */
function sameThreads(left: ReadonlyArray<SlackThread>, right: ReadonlyArray<SlackThread>) {
  return left.length === right.length && encodeThreads(left) === encodeThreads(right);
}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const github = yield* GitHubCli.GitHubCli;
  const webSocket = yield* Socket.WebSocketConstructor;
  const layerScope = yield* Scope.Scope;
  const limiter = new SlackRateLimiter();

  let connection: StoredConnection | undefined;
  let lastClientId: string | undefined;
  let connectionError: string | undefined;
  let authorization: PendingAuthorization | undefined;
  let syncFiber: Fiber.Fiber<void> | undefined;
  let wake = yield* Deferred.make<void>();

  const channels = new Map<string, ChannelState>();
  const users = new Map<string, { readonly name: string; readonly avatarUrl?: string }>();
  /** Whether a user is an app, for the ones looked up since start; mentions by apps don't count. */
  const appUsers = new Map<string, boolean>();
  /** Custom emoji name to image URL, or `alias:<name>`. */
  let customEmoji = new Map<string, string>();
  let channelsListedAt = 0;
  let lastSyncedAt: number | undefined;
  let syncError: string | undefined;
  let dirty = false;
  let publishedAt = 0;
  /** Your conversations and Devin threads still to be checked, by `channel:ts`. */
  const conversations = new Map<string, ConversationEntry>();
  /**
   * Bumped by every reaction the user changes here. A read that started before a change
   * would bring the old reactions back, so it is dropped and repeated instead.
   */
  let reactionGeneration = 0;
  let devinUser: DevinIdentity | null | undefined;
  /** Newest Devin message already seen by search. */
  let devinSeenTs: string | undefined;
  let devinLookedUp = false;
  let devinSearchedAt = 0;
  let searchScopeMissing = false;
  let devin: StoredDevin | undefined;
  let devinError: string | undefined;
  /** Devin's answer for each session id; `state` is absent when it could not be read. */
  const devinSessions = new Map<
    string,
    {
      readonly state?: SlackDevinSession["state"];
      readonly title?: string;
      readonly pullRequestUrls: ReadonlyArray<string>;
      readonly checkedAt: number;
    }
  >();
  let devinSessionsCheckedAt = 0;
  /** The user's pull request queue on GitHub; empty until `gh` answers. */
  let reviewRequests: ReadonlyArray<WorkGitHubPullRequest> = [];
  let authoredPullRequests: ReadonlyArray<WorkGitHubPullRequest> = [];
  let mergedPullRequests: ReadonlyArray<WorkGitHubPullRequest> = [];
  let githubQueueAt = 0;
  let dismissed: ReadonlyArray<SlackDismissedThread> = [];
  let conversationOwners: ReadonlyArray<ConversationOwner> = [];
  let conversationWaits: ReadonlyArray<ConversationWait> = [];
  let replyDrafts: ReadonlyArray<ReplyDraft> = [];
  /** The scopes Slack says this token has, from any call's response; unknown until then. */
  let grantedScopes: ReadonlySet<string> | undefined;
  const ownerWrites = yield* Semaphore.make(1);
  let inboxStartedAtMs = 0;
  const dismissedWrites = yield* Semaphore.make(1);
  let includedChannelIds = new Set<string>();
  const channelWrites = yield* Semaphore.make(1);
  let followedRefreshedAt = 0;
  /** Conversations your threads live in that are not in the polled channel set. */
  const followedChannels = new Map<
    string,
    { readonly name: string; readonly kind: SlackChannelKind }
  >();
  let members: { readonly at: number; readonly list: ReadonlyArray<SlackMember> } | undefined;
  /** GitHub state of PRs linked from the feed, by URL; `state` is absent when unreadable. */
  const pullRequestStates = new Map<
    string,
    { readonly state?: SlackPullRequest["state"]; readonly checkedAt: number }
  >();
  let pullRequestsScannedAt = 0;
  /** Messages that tag you, and your own, from the last search; `mineSince` bounds the latter. */
  let mentionHits: ReadonlyArray<SlackMentionHit> = [];
  let myHits: ReadonlyArray<SlackMentionHit> = [];
  let mineSince: string | undefined;
  let mentionsSearchedAt = 0;
  /** `channel:ts` of messages you reacted to, from the last `reactions.list`. */
  let reactedKeys = new Set<string>();
  /** Each unanswered mention's conversation root by `channel:ts`, and the mention by its ts. */
  const mentionRoots = new Map<string, SlackThread>();
  const mentionMessages = new Map<string, SlackMessage>();
  let appToken: string | undefined;
  let eventsStatus: SlackEvents["status"] = "off";
  let eventsError: string | undefined;
  let eventsFiber: Fiber.Fiber<void> | undefined;
  /**
   * With events arriving, a read happens because something changed; the polling schedule only
   * reconciles, every {@link SLACK_EVENTS_RECONCILE_MS} at most.
   */
  const reconcileDelay = (ms: number) =>
    eventsStatus === "live" ? Math.max(ms, SLACK_EVENTS_RECONCILE_MS) : ms;

  /** A conversation with the PRs Devin reported and each Devin session's state. */
  const conversationThread = (entry: ConversationEntry): SlackThread => {
    const thread = entry.thread!;
    const devinPullRequests = (thread.devin?.sessions ?? []).flatMap(
      (session) => devinSessions.get(session.id)?.pullRequestUrls ?? [],
    );
    const known = new Set((thread.pullRequests ?? []).map((request) => request.url));
    const pullRequests = [
      ...(thread.pullRequests ?? []),
      ...slackPullRequestLinks(devinPullRequests.join(" ")).filter(
        (request) => !known.has(request.url),
      ),
    ];
    return {
      ...thread,
      followed: entry.followed,
      ...(pullRequests.length > 0 ? { pullRequests } : {}),
      ...(thread.devin
        ? {
            devin: {
              ...thread.devin,
              sessions: thread.devin.sessions.map((session) => {
                const known = devinSessions.get(session.id);
                return {
                  ...session,
                  ...(known?.state ? { state: known.state } : {}),
                  ...(known?.title ? { title: known.title } : {}),
                };
              }),
            },
          }
        : {}),
    };
  };

  /** Your conversations, newest activity first. */
  const visibleConversations = () =>
    [...conversations.values()]
      .filter((entry) => isVisibleConversation(entry) && slackTsToMs(entry.ts) > inboxStartedAtMs)
      .sort(
        (left, right) =>
          Number.parseFloat(right.latestTs ?? right.ts) -
          Number.parseFloat(left.latestTs ?? left.ts),
      )
      .slice(0, CONVERSATIONS_LIMIT)
      .map(conversationThread);

  /** A newly seen PR link is read on the next loop instead of waiting for the interval. */
  const noteNewPullRequests = (threads: ReadonlyArray<SlackThread>) => {
    const unseen = threads.some((thread) =>
      thread.pullRequests?.some((request) => !pullRequestStates.has(request.url)),
    );
    if (unseen) pullRequestsScannedAt = 0;
  };

  const withPullRequestStates = (thread: SlackThread): SlackThread => {
    if (!thread.pullRequests) return thread;
    return {
      ...thread,
      pullRequests: thread.pullRequests.map((request) => {
        const state = pullRequestStates.get(request.url)?.state;
        return state ? { ...request, state } : request;
      }),
    };
  };

  const unanswered = () =>
    connection
      ? unansweredSlackMentions({
          mentions: mentionHits,
          mine: myHits,
          reacted: reactedKeys,
          me: connection.userId,
          mineSince,
        }).filter((hit) => slackTsToMs(hit.messageTs) > inboxStartedAtMs)
      : [];

  const currentMentions = (): SlackMention[] =>
    unanswered().flatMap((hit) => {
      const thread = mentionRoots.get(conversationKey(hit));
      const message = mentionMessages.get(`${hit.channelId}:${hit.messageTs}`);
      return thread && message
        ? [{ thread: withPullRequestStates(thread), message, permalink: hit.permalink }]
        : [];
    });

  const snapshot = (now: number): SlackState => {
    const rateLimitedUntil = limiter.pausedUntilMs(now);
    const connectionState: SlackConnection = authorization
      ? {
          status: "authorizing",
          clientId: authorization.clientId,
          authorizeUrl: authorization.authorizeUrl,
          ...(connectionError ? { error: connectionError } : {}),
          ...(connection
            ? {
                connectedAs: { teamName: connection.teamName, userName: connection.userName },
              }
            : {}),
        }
      : connection
        ? {
            status: "connected",
            clientId: connection.clientId,
            teamName: connection.teamName,
            teamUrl: connection.teamUrl,
            userId: connection.userId,
            userName: connection.userName,
            ...(missingScopes().length > 0 ? { missingScopes: missingScopes() } : {}),
          }
        : {
            status: "disconnected",
            ...(lastClientId ? { clientId: lastClientId } : {}),
            ...(connectionError ? { error: connectionError } : {}),
          };
    const channelStates = [...channels.values()].filter((channel) =>
      includedChannelIds.has(channel.id),
    );
    return {
      connection: connectionState,
      sync: {
        channelCount: channelStates.length,
        availableChannelCount: channels.size,
        syncedChannelCount: channelStates.filter((channel) => channel.synced).length,
        ...(lastSyncedAt ? { lastSyncedAt: isoTime(lastSyncedAt) } : {}),
        ...(rateLimitedUntil ? { rateLimitedUntil: isoTime(rateLimitedUntil) } : {}),
        ...(syncError ? { error: syncError } : {}),
      },
      threads: connection
        ? slackFeedOrder(channelStates.flatMap((channel) => channel.threads))
            .filter((thread) => Number.parseFloat(thread.ts) * 1000 > inboxStartedAtMs)
            .map(withPullRequestStates)
        : [],
      conversations: connection ? visibleConversations().map(withPullRequestStates) : [],
      mentions: connection ? currentMentions() : [],
      dismissed: connection ? dismissed : [],
      conversationOwners: connection ? conversationOwners : [],
      conversationWaits: connection ? conversationWaits : [],
      replyDrafts: connection ? replyDrafts : [],
      reviewRequests: connection ? reviewRequests : [],
      authoredPullRequests: connection ? authoredPullRequests : [],
      mergedPullRequests: connection ? mergedPullRequests : [],
      includedChannelIds: connection ? [...includedChannelIds] : [],
      ...(connection && devinUser?.avatarUrl ? { devinAvatarUrl: devinUser.avatarUrl } : {}),
      devin: devin
        ? {
            status: "connected",
            name: devin.name,
            orgId: devin.orgId,
            ...(devinError ? { error: devinError } : {}),
          }
        : { status: "disconnected", ...(devinError ? { error: devinError } : {}) },
      events: {
        status: appToken && connection ? eventsStatus : "off",
        ...(appToken && connection && eventsError ? { error: eventsError } : {}),
      },
    };
  };

  function missingScopes(): ReadonlyArray<string> {
    if (grantedScopes) return SLACK_USER_SCOPES.filter((scope) => !grantedScopes!.has(scope));
    return searchScopeMissing ? ["search:read"] : [];
  }

  const stateRef = yield* SubscriptionRef.make<SlackState>(
    snapshot(yield* Clock.currentTimeMillis),
  );
  let cacheSavedAt = 0;
  let cacheSaving = false;

  const cacheValue = (current: StoredConnection, now: number): StoredCache => ({
    version: 1,
    teamUrl: current.teamUrl,
    userId: current.userId,
    savedAt: now,
    channels: [...channels.values()]
      .filter((channel) => channel.synced)
      .map(({ id, name, kind, threads }) => ({ id, name, kind, threads })),
    conversations: [...conversations.values()].map((entry) => ({
      channelId: entry.channelId,
      ts: entry.ts,
      followed: entry.followed,
      devin: entry.devin,
      mine: entry.mine,
      ...(entry.thread ? { thread: entry.thread } : {}),
      ...(entry.latestTs ? { latestTs: entry.latestTs } : {}),
    })),
    users: [...users].map(([id, user]) => ({ id, ...user })),
    followedChannels: [...followedChannels].map(([id, channel]) => ({ id, ...channel })),
    ...(devinUser !== undefined ? { devinUser } : {}),
    ...(devinSeenTs ? { devinSeenTs } : {}),
    pullRequests: [...pullRequestStates].map(([url, known]) => ({ url, ...known })),
    devinSessions: [...devinSessions].map(([id, known]) => ({ id, ...known })),
    reviewRequests,
    authoredPullRequests,
    mergedPullRequests,
  });

  const saveCache = Effect.suspend(() => {
    const current = connection;
    if (!current || cacheSaving) return Effect.void;
    cacheSaving = true;
    return Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) => {
        cacheSavedAt = now;
        return secrets.set(
          CACHE_SECRET,
          new TextEncoder().encode(encodeStoredCache(cacheValue(current, now))),
        );
      }),
      Effect.ignore,
      Effect.ensuring(Effect.sync(() => void (cacheSaving = false))),
    );
  });

  /** Puts a cache from an earlier run back, so the first state already has the page. */
  const restoreCache = Effect.gen(function* () {
    const current = connection;
    if (!current) return;
    const stored = yield* secrets.get(CACHE_SECRET).pipe(
      Effect.map(Option.flatMap((bytes) => decodeStoredCache(new TextDecoder().decode(bytes)))),
      Effect.orElseSucceed(() => Option.none<StoredCache>()),
    );
    if (
      Option.isNone(stored) ||
      stored.value.teamUrl !== current.teamUrl ||
      stored.value.userId !== current.userId
    ) {
      return;
    }
    const cache = stored.value;
    const now = yield* Clock.currentTimeMillis;
    for (const user of cache.users) {
      users.set(user.id, {
        name: user.name,
        ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
      });
    }
    for (const channel of cache.followedChannels) {
      followedChannels.set(channel.id, { name: channel.name, kind: channel.kind });
    }
    // Channels come back on their usual schedule, busy ones first.
    for (const channel of cache.channels) {
      const latest = slackLatestActivityMs(
        channel.threads.map((thread) => ({
          ts: thread.ts,
          ...(thread.latestReplyTs ? { latest_reply: thread.latestReplyTs } : {}),
        })),
      );
      channels.set(channel.id, {
        id: channel.id,
        name: channel.name,
        kind: channel.kind,
        synced: true,
        threads: channel.threads,
        nextPollAt: now + slackPollDelayMs(latest, now) / 2,
      });
    }
    for (const saved of cache.conversations) {
      const yours = saved.followed || saved.mine;
      conversations.set(conversationKey(saved), {
        channelId: saved.channelId,
        ts: saved.ts,
        followed: saved.followed,
        devin: saved.devin,
        mine: saved.mine,
        ...(saved.thread ? { thread: saved.thread } : {}),
        ...(saved.latestTs ? { latestTs: saved.latestTs } : {}),
        // Search and your reactions say which ones changed; the rest wait their turn.
        nextReadAt: !saved.thread
          ? 0
          : yours
            ? now + slackConversationDelayMs(slackTsToMs(saved.latestTs ?? saved.ts), now)
            : Number.POSITIVE_INFINITY,
      });
    }
    if (cache.devinUser !== undefined) devinUser = cache.devinUser;
    if (cache.devinSeenTs) devinSeenTs = cache.devinSeenTs;
    for (const request of cache.pullRequests) {
      pullRequestStates.set(request.url, {
        ...(request.state ? { state: request.state } : {}),
        checkedAt: request.checkedAt,
      });
    }
    for (const session of cache.devinSessions) {
      devinSessions.set(session.id, {
        ...(session.state ? { state: session.state } : {}),
        ...(session.title ? { title: session.title } : {}),
        pullRequestUrls: session.pullRequestUrls,
        checkedAt: session.checkedAt,
      });
    }
    reviewRequests = cache.reviewRequests ?? [];
    authoredPullRequests = cache.authoredPullRequests ?? [];
    mergedPullRequests = cache.mergedPullRequests ?? [];
    lastSyncedAt = cache.savedAt;
    cacheSavedAt = now;
  });

  const publish = Effect.gen(function* () {
    dirty = false;
    publishedAt = yield* Clock.currentTimeMillis;
    yield* SubscriptionRef.set(stateRef, snapshot(publishedAt));
    if (connection && publishedAt - cacheSavedAt >= CACHE_SAVE_INTERVAL_MS) {
      yield* saveCache.pipe(Effect.forkIn(layerScope));
    }
  });

  const dismissedKept = (thread: SlackDismissedThread, cutoff: number) =>
    (thread.at ?? slackTsToMs(thread.ts)) > cutoff;

  const loadDismissed = Effect.gen(function* () {
    const cutoff = (yield* Clock.currentTimeMillis) - DISMISSED_RETENTION_MS;
    const stored = yield* secrets.get(DISMISSED_SECRET).pipe(
      Effect.map(Option.flatMap((bytes) => decodeStoredDismissed(new TextDecoder().decode(bytes)))),
      Effect.orElseSucceed(() => Option.none<typeof StoredDismissed.Type>()),
    );
    dismissed =
      connection &&
      Option.isSome(stored) &&
      stored.value.teamUrl === connection.teamUrl &&
      stored.value.userId === connection.userId
        ? stored.value.threads.filter((thread) => dismissedKept(thread, cutoff))
        : [];
  });

  const loadOwners = Effect.gen(function* () {
    const stored = yield* secrets.get(OWNERS_SECRET).pipe(
      Effect.map(Option.flatMap((bytes) => decodeStoredOwners(new TextDecoder().decode(bytes)))),
      Effect.orElseSucceed(() => Option.none<typeof StoredOwners.Type>()),
    );
    conversationOwners =
      connection &&
      Option.isSome(stored) &&
      stored.value.teamUrl === connection.teamUrl &&
      stored.value.userId === connection.userId
        ? stored.value.owners
        : [];
  });

  const loadWaits = Effect.gen(function* () {
    const stored = yield* secrets.get(WAITS_SECRET).pipe(
      Effect.map(Option.flatMap((bytes) => decodeStoredWaits(new TextDecoder().decode(bytes)))),
      Effect.orElseSucceed(() => Option.none<typeof StoredWaits.Type>()),
    );
    conversationWaits =
      connection &&
      Option.isSome(stored) &&
      stored.value.teamUrl === connection.teamUrl &&
      stored.value.userId === connection.userId
        ? stored.value.waits
        : [];
  });

  const loadDrafts = Effect.gen(function* () {
    const stored = yield* secrets.get(DRAFTS_SECRET).pipe(
      Effect.map(Option.flatMap((bytes) => decodeStoredDrafts(new TextDecoder().decode(bytes)))),
      Effect.orElseSucceed(() => Option.none<typeof StoredDrafts.Type>()),
    );
    replyDrafts =
      connection &&
      Option.isSome(stored) &&
      stored.value.teamUrl === connection.teamUrl &&
      stored.value.userId === connection.userId
        ? stored.value.drafts
        : [];
  });

  const loadIncludedChannels = Effect.gen(function* () {
    const stored = yield* secrets.get(INCLUDED_CHANNELS_SECRET).pipe(
      Effect.map(
        Option.flatMap((bytes) => decodeStoredIncludedChannels(new TextDecoder().decode(bytes))),
      ),
      Effect.orElseSucceed(() => Option.none<typeof StoredIncludedChannels.Type>()),
    );
    includedChannelIds = new Set(
      connection &&
        Option.isSome(stored) &&
        stored.value.teamUrl === connection.teamUrl &&
        stored.value.userId === connection.userId
        ? stored.value.channelIds
        : [],
    );
  });

  const loadInboxStart = Effect.gen(function* () {
    const stored = yield* secrets.get(INBOX_START_SECRET).pipe(
      Effect.map(
        Option.flatMap((bytes) => decodeStoredInboxStart(new TextDecoder().decode(bytes))),
      ),
      Effect.orElseSucceed(() => Option.none<typeof StoredInboxStart.Type>()),
    );
    inboxStartedAtMs =
      connection &&
      Option.isSome(stored) &&
      stored.value.teamUrl === connection.teamUrl &&
      stored.value.userId === connection.userId
        ? stored.value.startedAtMs
        : 0;
  });

  // ---------------------------------------------------------------------------
  // Web API

  const refreshAccessToken = Effect.fn("slack.refresh_access_token")(function* (
    current: StoredConnection,
  ) {
    if (!current.refreshToken) return yield* Effect.fail(slackError("oauth", "token_expired"));
    const body = yield* postForm("oauth.v2.access", {
      client_id: current.clientId,
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
    });
    const refreshed: StoredConnection = {
      ...current,
      accessToken: String(body.access_token),
      ...(typeof body.refresh_token === "string" ? { refreshToken: body.refresh_token } : {}),
      ...(typeof body.expires_in === "number"
        ? { expiresAtMs: (yield* Clock.currentTimeMillis) + body.expires_in * 1000 }
        : {}),
    };
    yield* persist(refreshed);
    connection = refreshed;
    return refreshed;
  });

  /** One Web API request, without the rate limiter; the OAuth endpoints take no token. */
  const postForm = (method: string, params: Record<string, string>, token?: string) =>
    Effect.gen(function* () {
      const request = HttpClientRequest.post(`https://slack.com/api/${method}`).pipe(
        HttpClientRequest.bodyUrlParams(params),
      );
      const response = yield* httpClient.execute(
        token ? request.pipe(HttpClientRequest.bearerToken(token)) : request,
      );
      // Slack names the token's scopes on every call, so a missing one shows before it is used.
      const scopes = response.headers["x-oauth-scopes"];
      if (token && typeof scopes === "string" && scopes.length > 0) {
        const next = new Set(scopes.split(",").map((scope) => scope.trim()));
        if (grantedScopes === undefined || next.size !== grantedScopes.size) dirty = true;
        grantedScopes = next;
      }
      if (response.status === 429) {
        const retryAfterSeconds = Number(response.headers["retry-after"]) || 30;
        limiter.pause(method, (yield* Clock.currentTimeMillis) + retryAfterSeconds * 1000);
        dirty = true;
        return yield* Effect.fail(
          slackError(method, `Slack is rate limiting; retrying in ${retryAfterSeconds}s.`),
        );
      }
      const body = (yield* response.json) as SlackResponse;
      if (!body.ok) return yield* Effect.fail(slackError(method, body.error ?? "unknown_error"));
      return body;
    }).pipe(
      Effect.timeout("20 seconds"),
      Effect.mapError((cause) =>
        isSlackError(cause) ? cause : slackError(method, "Slack could not be reached."),
      ),
    );

  const call = Effect.fn("slack.call")(function* (
    method: string,
    params: Record<string, string>,
    priority: SlackCallPriority,
  ) {
    let current = connection;
    if (!current) return yield* Effect.fail(slackError(method, "Slack is not connected."));
    if (
      current.expiresAtMs !== undefined &&
      current.expiresAtMs - 5 * 60_000 < (yield* Clock.currentTimeMillis)
    ) {
      current = yield* refreshAccessToken(current);
    }
    for (;;) {
      const wait = limiter.reserve(method, priority, yield* Clock.currentTimeMillis);
      if (wait === 0) break;
      if (priority === "interactive" && wait > INTERACTIVE_MAX_WAIT_MS) {
        return yield* Effect.fail(
          slackError(method, `Slack is rate limiting; try again in ${Math.ceil(wait / 1000)}s.`),
        );
      }
      yield* Effect.sleep(Duration.millis(wait));
    }
    return yield* postForm(method, params, current.accessToken).pipe(
      // Forked: the sync fiber making this call is one that dropping interrupts.
      Effect.tapError((error) =>
        AUTH_ERRORS.has(error.message)
          ? dropConnection(`Slack sign-in ended (${error.message}).`).pipe(
              Effect.forkIn(layerScope),
            )
          : Effect.void,
      ),
    );
  });

  // ---------------------------------------------------------------------------
  // Resolving people and emoji

  const ensureUsers = Effect.fn("slack.ensure_users")(function* (
    ids: Iterable<string>,
    priority: SlackCallPriority,
  ) {
    for (const id of new Set(ids)) {
      if (users.has(id)) continue;
      // A failed lookup is not cached, so the next read of the channel tries again.
      const body = yield* call("users.info", { user: id }, priority).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      const user = body?.user as SlackApiUser | undefined;
      if (!user) continue;
      appUsers.set(id, user.is_bot === true || user.is_app_user === true);
      users.set(id, {
        name: userDisplayName(user),
        ...(user.profile?.image_48 ? { avatarUrl: user.profile.image_48 } : {}),
      });
    }
  });

  /** Standard emoji become characters, workspace emoji images, following aliases. */
  const resolveEmoji = (name: string): Pick<SlackReaction, "unicode" | "imageUrl"> => {
    let current = name;
    for (let hops = 0; hops < 4; hops += 1) {
      const unicode = standardEmoji(current);
      if (unicode) return { unicode };
      const custom = customEmoji.get(current.split("::")[0] ?? current);
      if (custom === undefined) return {};
      if (!custom.startsWith("alias:")) return { imageUrl: custom };
      current = custom.slice("alias:".length);
    }
    return {};
  };

  const toReaction = (
    reaction: NonNullable<SlackApiMessage["reactions"]>[number],
  ): SlackReaction => ({
    name: reaction.name,
    count: reaction.count,
    reacted: connection ? (reaction.users ?? []).includes(connection.userId) : false,
    ...resolveEmoji(reaction.name),
  });

  /** A feed thread; its linked PRs get their state when the snapshot is taken. */
  const toThread = (
    message: SlackMessage,
    channel: { readonly name: string; readonly kind: SlackChannelKind },
  ): SlackThread => {
    const pullRequests = slackPullRequestLinks(message.markdown);
    return {
      ...message,
      channelName: channel.name,
      channelKind: channel.kind,
      permalink: slackPermalink(
        connection?.teamUrl ?? "https://slack.com/",
        message.channelId,
        message.ts,
      ),
      ...(pullRequests.length > 0 ? { pullRequests } : {}),
    };
  };

  const toMessage = (channelId: string, raw: SlackApiMessage): SlackMessage => {
    const author = raw.user ? users.get(raw.user) : undefined;
    const authorName =
      author?.name ?? raw.bot_profile?.name ?? raw.username ?? (raw.bot_id ? "App" : "Unknown");
    const avatarUrl = author?.avatarUrl ?? raw.bot_profile?.icons?.image_48;
    return {
      channelId,
      ts: raw.ts,
      authorName,
      ...(avatarUrl ? { authorAvatarUrl: avatarUrl } : {}),
      markdown: slackMrkdwnToMarkdown(raw.text ?? "", {
        userName: (id) => users.get(id)?.name,
        channelName: (id) => channels.get(id)?.name ?? followedChannels.get(id)?.name,
      }),
      fileCount: raw.files?.length ?? 0,
      ...(raw.files?.length ? { images: slackImages(raw.files) } : {}),
      edited: raw.edited !== undefined,
      replyCount: raw.reply_count ?? 0,
      ...(raw.latest_reply ? { latestReplyTs: raw.latest_reply } : {}),
      reactions: (raw.reactions ?? []).map(toReaction),
    };
  };

  const resolveMessages = Effect.fn("slack.resolve_messages")(function* (
    channelId: string,
    messages: ReadonlyArray<SlackApiMessage>,
    priority: SlackCallPriority,
  ) {
    yield* ensureUsers(
      messages.flatMap((message) => [
        ...(message.user ? [message.user] : []),
        ...slackMentionedUserIds(message.text ?? ""),
      ]),
      priority,
    );
    return messages.map((message) => toMessage(channelId, message));
  });

  // ---------------------------------------------------------------------------
  // Sync

  const listChannels = Effect.fn("slack.list_channels")(function* () {
    const listed: SlackApiChannel[] = [];
    let cursor = "";
    do {
      const body = yield* call(
        "users.conversations",
        {
          types: "public_channel,private_channel,mpim",
          exclude_archived: "true",
          limit: "200",
          ...(cursor ? { cursor } : {}),
        },
        "background",
      );
      listed.push(...((body.channels as SlackApiChannel[] | undefined) ?? []));
      cursor = (body.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "";
    } while (cursor);
    const ids = new Set(listed.map((channel) => channel.id));
    for (const id of channels.keys()) {
      if (!ids.has(id)) channels.delete(id);
    }
    for (const channel of listed) {
      const existing = channels.get(channel.id);
      if (existing) {
        existing.name = channelDisplayName(channel);
        existing.kind = channelKind(channel);
      } else {
        channels.set(channel.id, {
          id: channel.id,
          name: channelDisplayName(channel),
          kind: channelKind(channel),
          nextPollAt: 0,
          synced: false,
          threads: [],
        });
      }
    }
    channelsListedAt = yield* Clock.currentTimeMillis;
    dirty = true;
    if (customEmoji.size === 0) {
      const emoji = yield* call("emoji.list", {}, "background").pipe(
        Effect.orElseSucceed(() => undefined),
      );
      customEmoji = new Map(Object.entries((emoji?.emoji as Record<string, string>) ?? {}));
    }
  });

  const pollChannel = Effect.fn("slack.poll_channel")(function* (channel: ChannelState) {
    const now = yield* Clock.currentTimeMillis;
    const generation = reactionGeneration;
    const body = yield* call(
      "conversations.history",
      {
        channel: channel.id,
        oldest: String(Math.max(now - SLACK_FEED_WINDOW_MS, inboxStartedAtMs) / 1000),
        limit: "100",
      },
      "background",
    );
    const messages = ((body.messages as SlackApiMessage[] | undefined) ?? []).filter(
      isSlackThreadRoot,
    );
    const resolved = yield* resolveMessages(channel.id, messages, "background");
    if (generation !== reactionGeneration) {
      // A reaction changed meanwhile; read again rather than bring back the old one.
      channel.nextPollAt = 0;
      return;
    }
    const threads = resolved.map((message) => toThread(message, channel));
    if (!channel.synced || !sameThreads(threads, channel.threads)) {
      channel.threads = threads;
      noteNewPullRequests(threads);
      dirty = true;
    }
    channel.synced = true;
    channel.nextPollAt =
      now + reconcileDelay(slackPollDelayMs(slackLatestActivityMs(messages), now));
    lastSyncedAt = now;
  });

  // ---------------------------------------------------------------------------
  // Followed threads

  /** A conversation's name and kind, from the polled set or looked up once. */
  const describeChannel = Effect.fn("slack.describe_channel")(function* (
    channelId: string,
    priority: SlackCallPriority,
  ) {
    const polled = channels.get(channelId);
    if (polled) return { name: polled.name, kind: polled.kind };
    const known = followedChannels.get(channelId);
    if (known) return known;
    const info = yield* call("conversations.info", { channel: channelId }, priority);
    const channel = info.channel as SlackApiChannel | undefined;
    if (!channel) return yield* slackError("describe_channel", "Slack channel is unavailable.");
    let name = channelDisplayName(channel);
    if (channel.is_im && channel.user) {
      yield* ensureUsers([channel.user], priority);
      name = users.get(channel.user)?.name ?? name;
    }
    const described = { name, kind: channelKind(channel) };
    followedChannels.set(channelId, described);
    return described;
  });

  const conversationEntry = (ref: { readonly channelId: string; readonly ts: string }) => {
    const key = conversationKey(ref);
    let entry = conversations.get(key);
    if (!entry) {
      entry = {
        channelId: ref.channelId,
        ts: ref.ts,
        followed: false,
        devin: false,
        mine: false,
        nextReadAt: 0,
      };
      conversations.set(key, entry);
    }
    return entry;
  };

  /** Reads a whole conversation: who started it, who replied last, its PRs and Devin sessions. */
  const readConversation = Effect.fn("slack.read_conversation")(function* (
    entry: ConversationEntry,
  ) {
    const current = connection;
    if (!current) return;
    const generation = reactionGeneration;
    const body = yield* call(
      "conversations.replies",
      { channel: entry.channelId, ts: entry.ts, limit: "200" },
      "background",
    );
    const messages = (body.messages as SlackApiMessage[] | undefined) ?? [];
    const summary = summarizeSlackConversation(messages, current.userId, devinUser ?? undefined);
    const now = yield* Clock.currentTimeMillis;
    if (!summary) {
      conversations.delete(conversationKey(entry));
      dirty = true;
      return;
    }
    const channel = yield* describeChannel(entry.channelId, "background");
    const [root] = yield* resolveMessages(entry.channelId, [summary.root], "background");
    if (summary.lastReply?.userId) yield* ensureUsers([summary.lastReply.userId], "background");
    if (generation !== reactionGeneration) {
      // The user changed a reaction meanwhile; read again rather than bring back the old one.
      entry.nextReadAt = 0;
      return;
    }
    if (!root) return;
    const pullRequests = slackConversationPullRequests(summary);
    const previousDevin = entry.thread?.devin;
    const thread: SlackThread = {
      ...toThread(root, channel),
      ...(pullRequests.length > 0 ? { pullRequests } : {}),
      startedByMe: summary.startedByMe,
      ...(summary.lastReply
        ? {
            lastReply: {
              by: summary.lastReply.by,
              authorName:
                summary.lastReply.by === "devin"
                  ? "Devin"
                  : ((summary.lastReply.userId
                      ? users.get(summary.lastReply.userId)?.name
                      : undefined) ?? "Someone"),
              ts: summary.lastReply.ts,
            },
          }
        : {}),
      ...(summary.devin
        ? {
            devin: {
              sessions: summary.devin.sessionIds.map((id) => ({ id, url: devinSessionUrl(id) })),
              stopped: summary.devin.stopped,
              lastMessageTs: summary.devin.lastMessageTs,
            },
          }
        : {}),
    };
    if (summary.devin && summary.devin.lastMessageTs !== previousDevin?.lastMessageTs) {
      // Devin said something new; its session state is read again right away.
      for (const id of summary.devin.sessionIds) devinSessions.delete(id);
      devinSessionsCheckedAt = 0;
    }
    entry.mine = summary.mine;
    entry.latestTs = summary.latestTs;
    if (!entry.thread || !sameThreads([thread], [entry.thread])) {
      entry.thread = thread;
      noteNewPullRequests([thread]);
      dirty = true;
    }
    // A Devin thread that is not yours is read again only when Devin writes in it again.
    entry.nextReadAt =
      entry.followed || entry.mine
        ? now + reconcileDelay(slackConversationDelayMs(slackTsToMs(summary.latestTs), now))
        : Number.POSITIVE_INFINITY;
  });

  /** Re-reads the user's reactions; the follow mark lives in Slack, not here. */
  const refreshFollowed = Effect.fn("slack.refresh_followed")(function* (
    priority: SlackCallPriority,
  ) {
    const current = connection;
    if (!current) return;
    const generation = reactionGeneration;
    const items: SlackApiReactionItem[] = [];
    let cursor = "";
    for (let page = 0; page < 3; page += 1) {
      const body = yield* call(
        "reactions.list",
        { user: current.userId, full: "true", limit: "200", ...(cursor ? { cursor } : {}) },
        priority,
      );
      items.push(...((body.items as SlackApiReactionItem[] | undefined) ?? []));
      cursor = (body.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "";
      if (!cursor) break;
    }
    // A follow or unfollow made while this read was in flight wins; read again soon.
    if (generation !== reactionGeneration) return;
    const reacted = new Set<string>();
    for (const item of items) {
      const message = item.message;
      if (item.type !== "message" || !item.channel || !message) continue;
      if (message.reactions?.some((reaction) => reaction.users?.includes(current.userId))) {
        reacted.add(`${item.channel}:${message.ts}`);
      }
    }
    if (reacted.size !== reactedKeys.size || [...reacted].some((key) => !reactedKeys.has(key))) {
      reactedKeys = reacted;
      dirty = true;
    }
    const refs = slackFollowedRefs(items, current.userId, SLACK_FOLLOW_REACTION).filter(
      (ref) => slackTsToMs(ref.ts) > inboxStartedAtMs,
    );
    const marked = new Set(refs.map(conversationKey));
    for (const [key, entry] of conversations) {
      if (!entry.followed || marked.has(key)) continue;
      entry.followed = false;
      if (!entry.devin) conversations.delete(key);
      dirty = true;
    }
    for (const ref of refs) {
      const entry = conversationEntry(ref);
      if (!entry.followed) {
        entry.followed = true;
        entry.nextReadAt = 0;
        dirty = true;
      }
      const latestReply = ref.root?.latest_reply;
      if (latestReply && (!entry.latestTs || latestReply > entry.latestTs)) entry.nextReadAt = 0;
    }
    followedRefreshedAt = yield* Clock.currentTimeMillis;
  });

  /** Every match for a search, newest first, up to `maxPages` pages of 100. */
  const searchMessages = Effect.fn("slack.search_messages")(function* (
    query: string,
    maxPages: number,
  ) {
    const matches: SlackApiMentionMatch[] = [];
    let capped = false;
    for (let page = 1; page <= maxPages; page += 1) {
      const body = yield* call(
        "search.messages",
        { query, count: "100", page: String(page), sort: "timestamp", sort_dir: "desc" },
        "background",
      );
      const result = body.messages as
        | { matches?: SlackApiMentionMatch[]; paging?: { pages?: number } }
        | undefined;
      matches.push(...(result?.matches ?? []));
      const pages = result?.paging?.pages ?? 1;
      if (page >= pages) break;
      if (page === maxPages) capped = true;
    }
    return { matches, capped };
  });

  /**
   * Finds messages that tag you and your own messages since, then reads the conversation of
   * each one you have not answered so the Work page can show it.
   */
  const searchMentions = Effect.fn("slack.search_mentions")(function* () {
    const current = connection;
    if (!current) return;
    const now = yield* Clock.currentTimeMillis;
    const after = slackSearchAfterDate(Math.max(now - SLACK_MENTION_WINDOW_MS, inboxStartedAtMs));
    const tagged = yield* searchMessages(
      `<@${current.userId}> after:${after}`,
      SLACK_MENTION_MAX_PAGES,
    );
    const mine = yield* searchMessages(
      `from:<@${current.userId}> after:${after}`,
      SLACK_MENTION_MINE_MAX_PAGES,
    );
    if (connection !== current) return;
    const before = encodeMentions(currentMentions());
    const hits = tagged.matches.flatMap((match) => slackMentionHit(match) ?? []);
    // Search does not say who is an app, and apps tag people all day; ask Slack once per author.
    for (const id of new Set(hits.flatMap((hit) => hit.userId ?? []))) {
      if (appUsers.has(id)) continue;
      const body = yield* call("users.info", { user: id }, "background").pipe(
        Effect.orElseSucceed(() => undefined),
      );
      const user = body?.user as SlackApiUser | undefined;
      if (user) appUsers.set(id, user.is_bot === true || user.is_app_user === true);
    }
    if (connection !== current) return;
    mentionHits = hits.filter(
      (hit) => hit.userId !== undefined && appUsers.get(hit.userId) === false,
    );
    myHits = mine.matches.flatMap((match) => slackMentionHit(match) ?? []);
    // Mentions older than the last of your messages read can't be judged.
    mineSince = mine.capped ? myHits.at(-1)?.messageTs : undefined;
    const open = unanswered();
    const keep = new Set(open.map(conversationKey));
    for (const key of mentionRoots.keys()) if (!keep.has(key)) mentionRoots.delete(key);
    const keepMessages = new Set(open.map((hit) => `${hit.channelId}:${hit.messageTs}`));
    for (const key of mentionMessages.keys()) {
      if (!keepMessages.has(key)) mentionMessages.delete(key);
    }
    for (const hit of open) {
      const messageKey = `${hit.channelId}:${hit.messageTs}`;
      if (!mentionMessages.has(messageKey)) {
        const [message] = yield* resolveMessages(
          hit.channelId,
          [{ ts: hit.messageTs, text: hit.text, ...(hit.userId ? { user: hit.userId } : {}) }],
          "background",
        );
        if (message) mentionMessages.set(messageKey, message);
      }
      if (mentionRoots.has(conversationKey(hit))) continue;
      // One unreadable conversation should not hide the rest.
      const root = yield* Effect.gen(function* () {
        const body = yield* call(
          "conversations.replies",
          { channel: hit.channelId, ts: hit.ts, limit: "1" },
          "background",
        );
        const raw = ((body.messages as SlackApiMessage[] | undefined) ?? []).find(
          isSlackThreadRoot,
        );
        if (!raw) return undefined;
        const channel = yield* describeChannel(hit.channelId, "background");
        const [message] = yield* resolveMessages(hit.channelId, [raw], "background");
        return message ? toThread(message, channel) : undefined;
      }).pipe(Effect.orElseSucceed(() => undefined));
      if (root) mentionRoots.set(conversationKey(hit), root);
    }
    mentionsSearchedAt = now;
    if (encodeMentions(currentMentions()) !== before) dirty = true;
  });

  // ---------------------------------------------------------------------------
  // Devin

  /** Devin's Slack user, looked up once per sign-in; null when the workspace has none. */
  const lookUpDevin = Effect.fn("slack.look_up_devin")(function* () {
    let cursor = "";
    for (let page = 0; page < 10; page += 1) {
      const body = yield* call(
        "users.list",
        { limit: "200", ...(cursor ? { cursor } : {}) },
        "background",
      );
      const found = findDevinUser((body.members as SlackApiUser[] | undefined) ?? []);
      if (found) return found;
      cursor = (body.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "";
      if (!cursor) break;
    }
    return null;
  });

  /**
   * Finds conversations Devin wrote in through Slack search, newest first, stopping at the
   * newest message seen last time. Each one is read to learn whether it is yours.
   */
  const searchDevin = Effect.fn("slack.search_devin")(function* () {
    // Once per run for an identity cached before its logo was kept.
    if (devinUser === undefined || (devinUser !== null && !devinUser.avatarUrl && !devinLookedUp)) {
      devinLookedUp = true;
      devinUser = yield* lookUpDevin();
    }
    if (devinUser === null) return;
    const now = yield* Clock.currentTimeMillis;
    const query = `from:<@${devinUser.userId}> after:${slackSearchAfterDate(
      Math.max(now - DEVIN_SEARCH_WINDOW_MS, inboxStartedAtMs),
    )}`;
    let newest = devinSeenTs;
    pages: for (let page = 1; page <= DEVIN_SEARCH_MAX_PAGES; page += 1) {
      const body = yield* call(
        "search.messages",
        { query, count: "100", page: String(page), sort: "timestamp", sort_dir: "desc" },
        "background",
      ).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            if (error.message === "missing_scope" && !searchScopeMissing) {
              searchScopeMissing = true;
              dirty = true;
            }
          }),
        ),
      );
      if (searchScopeMissing) {
        searchScopeMissing = false;
        dirty = true;
      }
      const result = body.messages as
        | { matches?: SlackApiSearchMatch[]; paging?: { pages?: number } }
        | undefined;
      for (const match of result?.matches ?? []) {
        const ref = slackSearchMatchThread(match);
        if (!ref) continue;
        if (devinSeenTs && Number.parseFloat(ref.messageTs) <= Number.parseFloat(devinSeenTs)) {
          break pages;
        }
        if (!newest || Number.parseFloat(ref.messageTs) > Number.parseFloat(newest)) {
          newest = ref.messageTs;
        }
        if (slackTsToMs(ref.ts) <= inboxStartedAtMs) continue;
        const entry = conversationEntry(ref);
        if (!entry.devin) {
          entry.devin = true;
          entry.nextReadAt = 0;
        } else if (!entry.latestTs || ref.messageTs > entry.latestTs) {
          entry.nextReadAt = 0;
        }
      }
      if (page >= (result?.paging?.pages ?? 1)) break;
    }
    devinSeenTs = newest;
  });

  /** One Devin API request with the saved key. */
  const devinRequest = (key: string, path: string) =>
    Effect.gen(function* () {
      const response = yield* httpClient.execute(
        HttpClientRequest.get(`https://api.devin.ai${path}`).pipe(
          HttpClientRequest.bearerToken(key),
          HttpClientRequest.acceptJson,
        ),
      );
      if (response.status === 401 || response.status === 403) {
        return yield* slackError("devin", "Devin did not accept the API key.");
      }
      if (response.status === 404) return yield* slackError("devin", "not_found");
      if (response.status >= 400) {
        return yield* slackError("devin", `Devin answered with HTTP ${response.status}.`);
      }
      return (yield* response.json) as Record<string, unknown>;
    }).pipe(
      Effect.timeout("20 seconds"),
      Effect.mapError((cause) =>
        isSlackError(cause) ? cause : slackError("devin", "Devin could not be reached."),
      ),
    );

  /** Reads the state of Devin sessions in your conversations, a few per pass. */
  const refreshDevinSessions = Effect.fn("slack.refresh_devin_sessions")(function* () {
    const key = devin;
    if (!key) return;
    const now = yield* Clock.currentTimeMillis;
    devinSessionsCheckedAt = now;
    const ids = new Set(
      [...conversations.values()]
        .filter(isVisibleConversation)
        .flatMap((entry) => entry.thread?.devin?.sessions.map((session) => session.id) ?? []),
    );
    const due = [...ids]
      .filter((id) => {
        const known = devinSessions.get(id);
        return !known || now - known.checkedAt >= devinSessionRecheckMs(known.state);
      })
      .slice(0, DEVIN_SESSIONS_PER_PASS);
    for (const id of due) {
      const result = yield* devinRequest(
        key.apiKey,
        `/v3/organizations/${key.orgId}/sessions/devin-${id}`,
      ).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false as const, error }),
          onSuccess: (body) => ({ ok: true as const, body }),
        }),
      );
      if (!result.ok) {
        if (result.error.message === "Devin did not accept the API key.") {
          devinError = result.error.message;
          dirty = true;
          return;
        }
        devinSessions.set(id, { pullRequestUrls: [], checkedAt: now });
        continue;
      }
      const body = result.body;
      const state = devinSessionState(
        typeof body.status === "string" ? body.status : undefined,
        typeof body.status_detail === "string" ? body.status_detail : null,
      );
      const pullRequestUrls = Array.isArray(body.pull_requests)
        ? body.pull_requests.flatMap((request: unknown) => {
            const url = (request as { pr_url?: unknown } | null)?.pr_url;
            return typeof url === "string" ? [url] : [];
          })
        : [];
      const previous = devinSessions.get(id);
      devinSessions.set(id, {
        ...(state ? { state } : {}),
        ...(typeof body.title === "string" && body.title ? { title: body.title } : {}),
        pullRequestUrls,
        checkedAt: now,
      });
      if (
        previous?.state !== state ||
        previous?.pullRequestUrls.length !== pullRequestUrls.length
      ) {
        dirty = true;
        if (pullRequestUrls.some((url) => !pullRequestStates.has(url))) pullRequestsScannedAt = 0;
      }
    }
    if (devinError) {
      devinError = undefined;
      dirty = true;
    }
  });

  // ---------------------------------------------------------------------------
  // Linked pull requests

  /**
   * Reads the state of PRs linked from the feed through `gh`, batched. New links are read right
   * away; unknown and open PRs again after an interval. Without `gh` or access they stay unknown.
   */
  const refreshPullRequests = Effect.fn("slack.refresh_pull_requests")(function* () {
    const now = yield* Clock.currentTimeMillis;
    pullRequestsScannedAt = now;
    const due = new Set<string>();
    const visible = [...channels.values()]
      .filter((channel) => includedChannelIds.has(channel.id))
      .flatMap((channel) => channel.threads);
    for (const thread of [...visible, ...visibleConversations()]) {
      for (const request of thread.pullRequests ?? []) {
        const known = pullRequestStates.get(request.url);
        const stale =
          known === undefined ||
          ((known.state === undefined || known.state === "open") &&
            now - known.checkedAt >= SLACK_PULL_REQUEST_INTERVAL_MS);
        if (stale) due.add(request.url);
      }
    }
    const urls = [...due];
    for (let start = 0; start < urls.length; start += SLACK_PULL_REQUEST_BATCH) {
      const batch = urls.slice(start, start + SLACK_PULL_REQUEST_BATCH);
      const result = yield* Effect.exit(
        github.execute({
          cwd: globalThis.process.cwd(),
          args: [
            "api",
            "--hostname",
            "github.com",
            "graphql",
            "-f",
            `query=${slackPullRequestStateQuery(batch)}`,
          ],
          rateLimitHost: "github.com",
        }),
      );
      const states = Exit.isSuccess(result)
        ? slackPullRequestStates(batch, Option.getOrUndefined(decodeJson(result.value.stdout)))
        : new Map<string, SlackPullRequest["state"]>();
      for (const url of batch) {
        const state = states.get(url);
        if (pullRequestStates.get(url)?.state !== state) dirty = true;
        pullRequestStates.set(url, { ...(state ? { state } : {}), checkedAt: now });
      }
    }
  });

  /** Reads the user's GitHub queue; without `gh` or access it stays as it was. */
  const refreshGitHubQueue = Effect.fn("slack.refresh_github_queue")(function* () {
    githubQueueAt = yield* Clock.currentTimeMillis;
    const result = yield* Effect.exit(
      github.execute({
        cwd: globalThis.process.cwd(),
        args: [
          "api",
          "--hostname",
          "github.com",
          "graphql",
          "-f",
          `query=${githubQueueQuery(DateTime.formatIso(DateTime.makeUnsafe(githubQueueAt - 15 * 24 * 60 * 60_000)).slice(0, 10))}`,
        ],
        rateLimitHost: "github.com",
      }),
    );
    if (Exit.isFailure(result)) return;
    const queue = parseGitHubQueue(Option.getOrUndefined(decodeJson(result.value.stdout)));
    if (!queue) return;
    const same = (
      left: ReadonlyArray<WorkGitHubPullRequest>,
      right: ReadonlyArray<WorkGitHubPullRequest>,
    ) => encodePullRequests(left) === encodePullRequests(right);
    if (
      !same(queue.reviewRequested, reviewRequests) ||
      !same(queue.authored, authoredPullRequests) ||
      !same(queue.merged, mergedPullRequests)
    ) {
      reviewRequests = queue.reviewRequested;
      authoredPullRequests = queue.authored;
      mergedPullRequests = queue.merged;
      dirty = true;
    }
  });

  const syncLoop = Effect.gen(function* () {
    for (;;) {
      const now = yield* Clock.currentTimeMillis;
      if (now - pullRequestsScannedAt >= SLACK_PULL_REQUEST_INTERVAL_MS) {
        yield* refreshPullRequests();
      }
      if (now - githubQueueAt >= GITHUB_QUEUE_INTERVAL_MS) {
        yield* refreshGitHubQueue();
      }
      if (now - followedRefreshedAt >= reconcileDelay(SLACK_FOLLOWED_INTERVAL_MS)) {
        const refreshed = yield* Effect.exit(refreshFollowed("background"));
        if (Exit.isFailure(refreshed)) {
          // Retry in a minute; the channel feed keeps going meanwhile.
          followedRefreshedAt = now - SLACK_FOLLOWED_INTERVAL_MS + 60_000;
        }
      }
      if (now - channelsListedAt >= SLACK_CHANNEL_LIST_INTERVAL_MS) {
        const listed = yield* Effect.exit(listChannels());
        if (Exit.isFailure(listed)) {
          syncError = "Could not list your Slack channels.";
          channelsListedAt = now - SLACK_CHANNEL_LIST_INTERVAL_MS + 60_000;
          dirty = true;
        }
      }
      if (now - devinSearchedAt >= DEVIN_SEARCH_INTERVAL_MS) {
        devinSearchedAt = now;
        const searched = yield* Effect.exit(searchDevin());
        if (Exit.isFailure(searched) && !searchScopeMissing) {
          // Retry in a minute; a missing permission waits for the next sign-in instead.
          devinSearchedAt = now - DEVIN_SEARCH_INTERVAL_MS + 60_000;
        }
      }
      if (devin && now - devinSessionsCheckedAt >= DEVIN_SESSIONS_INTERVAL_MS) {
        yield* Effect.exit(refreshDevinSessions());
      }
      if (now - mentionsSearchedAt >= reconcileDelay(SLACK_MENTION_INTERVAL_MS)) {
        const searched = yield* Effect.exit(searchMentions());
        // Retry in a minute; a missing permission shows through the Devin search's notice.
        if (Exit.isFailure(searched)) mentionsSearchedAt = now - SLACK_MENTION_INTERVAL_MS + 60_000;
      }
      // Your conversations come before the channel feed; Devin threads not yet known to be
      // yours come after it, so a first search's backlog does not hold up new threads.
      let dueMine: ConversationEntry | undefined;
      let dueCandidate: ConversationEntry | undefined;
      for (const entry of conversations.values()) {
        const yours = entry.followed || entry.mine;
        const best = yours ? dueMine : dueCandidate;
        if (best !== undefined && best.nextReadAt <= entry.nextReadAt) continue;
        if (yours) dueMine = entry;
        else dueCandidate = entry;
      }
      let due: ChannelState | undefined;
      for (const channel of channels.values()) {
        if (!includedChannelIds.has(channel.id)) continue;
        if (due === undefined || channel.nextPollAt < due.nextPollAt) due = channel;
      }
      const channelDue = due !== undefined && due.nextPollAt <= now;
      const dueConversation =
        dueMine !== undefined &&
        dueMine.nextReadAt <= now &&
        (!channelDue || dueMine.nextReadAt <= due!.nextPollAt)
          ? dueMine
          : !channelDue && dueCandidate !== undefined && dueCandidate.nextReadAt <= now
            ? dueCandidate
            : undefined;
      if (dueConversation !== undefined) {
        const entry = dueConversation;
        const read = yield* Effect.exit(readConversation(entry));
        const readAt = yield* Clock.currentTimeMillis;
        if (Exit.isFailure(read)) {
          // One unreadable conversation should not hold up the rest.
          entry.nextReadAt = Math.max(readAt + 5 * 60_000, limiter.pausedUntilMs(readAt) ?? 0);
        }
        if (dirty && readAt - publishedAt >= PUBLISH_INTERVAL_MS) yield* publish;
        continue;
      }
      if (due !== undefined && due.nextPollAt <= now) {
        const polled = yield* Effect.exit(pollChannel(due));
        const polledAt = yield* Clock.currentTimeMillis;
        if (Exit.isFailure(polled)) {
          // Retry after any Slack pause, and not sooner than a minute.
          due.nextPollAt = Math.max(polledAt + 60_000, limiter.pausedUntilMs(polledAt) ?? 0);
          syncError = `Could not read ${due.name}.`;
          dirty = true;
        } else if (syncError) {
          syncError = undefined;
          dirty = true;
        }
        if (dirty && polledAt - publishedAt >= PUBLISH_INTERVAL_MS) yield* publish;
        continue;
      }
      if (dirty) yield* publish;
      const nextAt = Math.min(
        due?.nextPollAt ?? Number.POSITIVE_INFINITY,
        dueMine?.nextReadAt ?? Number.POSITIVE_INFINITY,
        dueCandidate?.nextReadAt ?? Number.POSITIVE_INFINITY,
        channelsListedAt + SLACK_CHANNEL_LIST_INTERVAL_MS,
        followedRefreshedAt + reconcileDelay(SLACK_FOLLOWED_INTERVAL_MS),
        pullRequestsScannedAt + SLACK_PULL_REQUEST_INTERVAL_MS,
        githubQueueAt + GITHUB_QUEUE_INTERVAL_MS,
        devinSearchedAt + DEVIN_SEARCH_INTERVAL_MS,
        mentionsSearchedAt + reconcileDelay(SLACK_MENTION_INTERVAL_MS),
        devin ? devinSessionsCheckedAt + DEVIN_SESSIONS_INTERVAL_MS : Number.POSITIVE_INFINITY,
      );
      yield* Effect.raceFirst(
        Effect.sleep(Duration.millis(Math.max(1_000, nextAt - now))),
        Deferred.await(wake),
      );
      if (yield* Deferred.isDone(wake)) wake = yield* Deferred.make<void>();
    }
  });

  const stopEvents = Effect.suspend(() => {
    const fiber = eventsFiber;
    eventsFiber = undefined;
    eventsStatus = "off";
    eventsError = undefined;
    return fiber ? Fiber.interrupt(fiber) : Effect.void;
  });

  const stopSync = Effect.suspend(() => {
    const fiber = syncFiber;
    syncFiber = undefined;
    return Effect.andThen(fiber ? Fiber.interrupt(fiber) : Effect.void, stopEvents);
  });

  // ---------------------------------------------------------------------------
  // Live events

  /** Reads everything soon, for when events may have been missed or stop arriving. */
  const catchUp = Effect.gen(function* () {
    for (const channel of channels.values()) channel.nextPollAt = 0;
    for (const entry of conversations.values()) {
      if (entry.followed || entry.mine) entry.nextReadAt = 0;
    }
    followedRefreshedAt = 0;
    mentionsSearchedAt = 0;
    yield* Deferred.succeed(wake, undefined);
  });

  const setEventsStatus = (status: SlackEvents["status"], error?: string) =>
    Effect.gen(function* () {
      const wasLive = eventsStatus === "live";
      if (eventsStatus === status && eventsError === error) return;
      eventsStatus = status;
      eventsError = error;
      // Polling waited on events; without them it picks up at once.
      if (wasLive && status !== "live") yield* catchUp;
      yield* publish;
    });

  /** A fresh Socket Mode URL; each one connects once. */
  const openSocketUrl = (token: string) =>
    Effect.gen(function* () {
      // Not `postForm`: the app token's scopes are not the user's, and must not be recorded.
      const response = yield* httpClient.execute(
        HttpClientRequest.post("https://slack.com/api/apps.connections.open").pipe(
          HttpClientRequest.bearerToken(token),
        ),
      );
      const body = (yield* response.json) as SlackResponse;
      if (!body.ok || typeof body.url !== "string") {
        return yield* slackError("events", body.error ?? "unknown_error");
      }
      return body.url;
    }).pipe(
      Effect.timeout("20 seconds"),
      Effect.mapError((cause) =>
        isSlackError(cause) ? cause : slackError("events", "Slack could not be reached."),
      ),
    );

  /** Marks what an event touched to be read within {@link SLACK_EVENT_DEBOUNCE_MS}. */
  const handleEvent = (event: SlackApiEvent) =>
    Effect.gen(function* () {
      const current = connection;
      if (!current) return;
      const target = slackEventTarget(event, current.userId);
      if (!target) return;
      const now = yield* Clock.currentTimeMillis;
      const soon = now + SLACK_EVENT_DEBOUNCE_MS;
      const searchSoon = now + SLACK_EVENT_SEARCH_DELAY_MS;
      const conversation = conversations.get(conversationKey(target));
      if (conversation && conversation.nextReadAt > soon) conversation.nextReadAt = soon;
      const channel = channels.get(target.channelId);
      const inFeed =
        channel !== undefined &&
        includedChannelIds.has(channel.id) &&
        (target.kind === "message"
          ? !target.reply || channel.threads.some((thread) => thread.ts === target.ts)
          : channel.threads.some((thread) => thread.ts === target.ts));
      if (channel && inFeed && channel.nextPollAt > soon) channel.nextPollAt = soon;
      if (target.kind === "message") {
        if (target.userId === current.userId && event.subtype === undefined && event.ts) {
          // Your message answers mentions in its conversation now, without another search.
          myHits = [
            {
              channelId: target.channelId,
              ts: target.ts,
              messageTs: event.ts,
              userId: current.userId,
              direct: target.channelId.startsWith("D"),
              text: "",
              permalink: "",
            },
            ...myHits,
          ];
          dirty = true;
        } else if (target.mentionsMe) {
          // A new mention: search once Slack has indexed it.
          mentionsSearchedAt = Math.min(
            mentionsSearchedAt,
            searchSoon - reconcileDelay(SLACK_MENTION_INTERVAL_MS),
          );
        }
        if (devinUser && target.userId === devinUser.userId) {
          devinSearchedAt = Math.min(devinSearchedAt, searchSoon - DEVIN_SEARCH_INTERVAL_MS);
        }
      } else if (target.userId === current.userId) {
        if (target.added) {
          reactedKeys.add(`${target.channelId}:${target.ts}`);
          dirty = true;
        }
        if (target.reaction === SLACK_FOLLOW_REACTION || !target.added) {
          followedRefreshedAt = Math.min(
            followedRefreshedAt,
            soon - reconcileDelay(SLACK_FOLLOWED_INTERVAL_MS),
          );
        }
      }
      yield* Deferred.succeed(wake, undefined);
    });

  /** Keeps a Socket Mode connection open while there is a token, reconnecting as Slack asks. */
  const eventsLoop = Effect.gen(function* () {
    let failures = 0;
    for (;;) {
      const token = appToken;
      if (!token || !connection) return;
      if (eventsStatus !== "live") yield* setEventsStatus("connecting", eventsError);
      const result = yield* Effect.exit(
        openSocketUrl(token).pipe(
          Effect.flatMap((url) =>
            runSlackSocket(url, {
              onHello: Effect.gen(function* () {
                failures = 0;
                yield* setEventsStatus("live");
              }),
              onEvent: handleEvent,
            }),
          ),
        ),
      );
      if (Exit.isSuccess(result)) {
        if (result.value === "link_disabled") {
          return yield* setEventsStatus(
            "failed",
            "Socket Mode is off for this Slack app. Turn it on in the app's settings.",
          );
        }
        // Slack refreshes connections every few hours; events wait for the next one.
        continue;
      }
      const error = Option.getOrUndefined(Exit.findErrorOption(result));
      const message = error && isSlackError(error) ? error.message : "The connection dropped.";
      if (slackSocketErrorIsFinal(message)) {
        return yield* setEventsStatus(
          "failed",
          `Slack did not accept the app-level token (${message}).`,
        );
      }
      failures += 1;
      yield* setEventsStatus("connecting", "Reconnecting to Slack…");
      yield* Effect.sleep(Duration.seconds(Math.min(60, 2 ** failures)));
    }
  }).pipe(Effect.provideService(Socket.WebSocketConstructor, webSocket));

  const startEvents = Effect.gen(function* () {
    yield* stopEvents;
    if (!appToken || !connection) return;
    eventsFiber = yield* eventsLoop.pipe(Effect.forkIn(layerScope));
  });

  /** Starts reading Slack; `restore` first brings back what an earlier run read. */
  const startSync = (restore: boolean) =>
    Effect.gen(function* () {
      yield* stopSync;
      channels.clear();
      users.clear();
      appUsers.clear();
      customEmoji = new Map();
      channelsListedAt = 0;
      lastSyncedAt = undefined;
      syncError = undefined;
      followedRefreshedAt = 0;
      followedChannels.clear();
      conversations.clear();
      devinUser = undefined;
      devinSeenTs = undefined;
      devinSearchedAt = 0;
      searchScopeMissing = false;
      devinSessions.clear();
      devinSessionsCheckedAt = 0;
      members = undefined;
      pullRequestStates.clear();
      pullRequestsScannedAt = 0;
      reviewRequests = [];
      authoredPullRequests = [];
      mergedPullRequests = [];
      githubQueueAt = 0;
      mentionHits = [];
      myHits = [];
      mineSince = undefined;
      // The first mention search waits for the feed and your conversations, which share
      // search's rate budget and matter more on a fresh start.
      mentionsSearchedAt =
        (yield* Clock.currentTimeMillis) - SLACK_MENTION_INTERVAL_MS + SLACK_MENTION_FIRST_DELAY_MS;
      reactedKeys = new Set();
      mentionRoots.clear();
      mentionMessages.clear();
      if (restore) yield* restoreCache;
      syncFiber = yield* syncLoop.pipe(Effect.forkIn(layerScope));
      yield* startEvents;
    });

  // ---------------------------------------------------------------------------
  // Connection

  const persist = (value: StoredConnection) =>
    secrets
      .set(CONNECTION_SECRET, new TextEncoder().encode(encodeStoredConnection(value)))
      .pipe(Effect.mapError(() => slackError("connect", "Could not save the Slack connection.")));

  const dropConnection = (error: string | undefined) =>
    Effect.gen(function* () {
      if (connection) lastClientId = connection.clientId;
      connection = undefined;
      connectionError = error;
      yield* stopSync;
      channels.clear();
      conversations.clear();
      dismissed = [];
      conversationOwners = [];
      conversationWaits = [];
      replyDrafts = [];
      grantedScopes = undefined;
      includedChannelIds = new Set();
      members = undefined;
      yield* secrets.remove(CONNECTION_SECRET).pipe(Effect.ignore);
      yield* secrets.remove(CACHE_SECRET).pipe(Effect.ignore);
      yield* publish;
    });

  /**
   * Ends a pending sign-in and closes its loopback. From inside the callback the
   * close waits a moment, so the page being served still reaches the browser.
   */
  const endAuthorization = (deferClose: boolean) =>
    Effect.suspend(() => {
      const pending = authorization;
      authorization = undefined;
      if (!pending) return Effect.void;
      const close = Scope.close(pending.scope, Exit.void);
      return deferClose
        ? close.pipe(Effect.delay("1 second"), Effect.forkIn(layerScope), Effect.asVoid)
        : close;
    });

  const finishAuthorization = Effect.fn("slack.finish_authorization")(function* (
    pending: PendingAuthorization,
    code: string,
  ) {
    const token = yield* postForm("oauth.v2.access", {
      client_id: pending.clientId,
      code,
      code_verifier: pending.verifier,
      redirect_uri: SLACK_OAUTH_REDIRECT_URI,
    });
    const authedUser = token.authed_user as
      | {
          id?: string;
          access_token?: string;
          refresh_token?: string;
          expires_in?: number;
        }
      | undefined;
    if (!authedUser?.access_token || !authedUser.id) {
      return yield* Effect.fail(slackError("oauth", "Slack did not return a user token."));
    }
    const identity = yield* postForm("auth.test", {}, authedUser.access_token);
    const next: StoredConnection = {
      clientId: pending.clientId,
      accessToken: authedUser.access_token,
      ...(authedUser.refresh_token ? { refreshToken: authedUser.refresh_token } : {}),
      ...(authedUser.expires_in
        ? { expiresAtMs: (yield* Clock.currentTimeMillis) + authedUser.expires_in * 1000 }
        : {}),
      teamName: String(identity.team ?? (token.team as { name?: string } | undefined)?.name ?? ""),
      teamUrl: String(identity.url ?? "https://slack.com/"),
      userId: authedUser.id,
      userName: String(identity.user ?? authedUser.id),
    };
    yield* persist(next);
    connection = next;
    yield* loadDismissed;
    yield* loadIncludedChannels;
    yield* loadOwners;
    yield* loadWaits;
    yield* loadDrafts;
    yield* loadInboxStart;
    connectionError = undefined;
    lastClientId = next.clientId;
    if (authorization === pending) yield* endAuthorization(true);
    yield* startSync(true);
    yield* publish;
  });

  /** Validates a redirect back from Slack and finishes sign-in. */
  const handleRedirect = (url: URL) =>
    Effect.gen(function* () {
      const pending = authorization;
      if (!pending || url.searchParams.get("state") !== pending.state) {
        return yield* Effect.fail(
          slackError("oauth", "This sign-in link is no longer valid. Start again from T3 Code."),
        );
      }
      const denied = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (denied || !code) {
        connectionError =
          denied === "access_denied" ? "Slack sign-in was cancelled." : (denied ?? "");
        yield* endAuthorization(true);
        yield* publish;
        return yield* Effect.fail(slackError("oauth", connectionError || "Missing code."));
      }
      yield* finishAuthorization(pending, code).pipe(
        Effect.tapError((error) =>
          Effect.suspend(() => {
            connectionError = error.message;
            return publish;
          }),
        ),
      );
    });

  const callbackPage = (title: string, detail: string) =>
    HttpServerResponse.html(`<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="color-scheme" content="light dark" /><title>${title}</title></head>
<body style="font-family:ui-sans-serif,-apple-system,sans-serif;display:grid;place-items:center;min-height:90vh">
<main style="text-align:center"><h1 style="font-size:20px">${title}</h1><p>${detail}</p></main></body></html>`);

  const startLoopback = (scope: Scope.Closeable) =>
    HttpRouter.serve(
      HttpRouter.add(
        "GET",
        "/slack/callback",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const exit = yield* Effect.exit(
            handleRedirect(new URL(request.originalUrl, SLACK_OAUTH_REDIRECT_URI)),
          );
          return Exit.isSuccess(exit)
            ? callbackPage("Slack connected", "You can close this tab and return to T3 Code.")
            : callbackPage("Slack sign-in failed", "Return to T3 Code for details.");
        }),
      ),
      { disableListenLog: true, disableLogger: true },
    ).pipe(
      Layer.provide(
        NodeHttpServer.layer(NodeHttp.createServer, {
          host: "127.0.0.1",
          port: SLACK_OAUTH_LOOPBACK_PORT,
          disablePreemptiveShutdown: true,
        }),
      ),
      Layer.build,
      Effect.provideService(Scope.Scope, scope),
    );

  const connect = Effect.fn("slack.connect")(
    function* (input: SlackConnectInput) {
      yield* endAuthorization(false);
      const verifier = Encoding.encodeBase64Url(yield* crypto.randomBytes(32));
      const challenge = Encoding.encodeBase64Url(
        yield* crypto.digest("SHA-256", new TextEncoder().encode(verifier)),
      );
      const state = Encoding.encodeBase64Url(yield* crypto.randomBytes(16));
      const authorizeUrl = new URL("https://slack.com/oauth/v2/authorize");
      authorizeUrl.search = new URLSearchParams({
        client_id: input.clientId,
        scope: "",
        user_scope: SLACK_USER_SCOPES.join(","),
        redirect_uri: SLACK_OAUTH_REDIRECT_URI,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString();
      const scope = yield* Scope.fork(layerScope);
      const pending: PendingAuthorization = {
        clientId: input.clientId,
        state,
        verifier,
        authorizeUrl: authorizeUrl.toString(),
        scope,
      };
      authorization = pending;
      lastClientId = input.clientId;
      connectionError = undefined;
      yield* secrets
        .set(CLIENT_ID_SECRET, new TextEncoder().encode(input.clientId))
        .pipe(Effect.ignore);
      // Another app may hold the port; pasting the redirect URL still works then.
      const listening = yield* Effect.exit(startLoopback(scope));
      if (Exit.isFailure(listening)) {
        yield* Effect.logWarning("slack sign-in loopback unavailable", {
          port: SLACK_OAUTH_LOOPBACK_PORT,
        });
      }
      const expire = Effect.gen(function* () {
        if (authorization !== pending) return;
        // Deferred: this fiber lives in the scope being closed.
        yield* endAuthorization(true);
        connectionError = "Slack sign-in timed out.";
        yield* publish;
      });
      yield* expire.pipe(Effect.delay(AUTHORIZATION_TIMEOUT), Effect.forkIn(scope));
      yield* publish;
      return snapshot(yield* Clock.currentTimeMillis).connection;
    },
    Effect.mapError(() => slackError("connect", "Could not start Slack sign-in.")),
  );

  const completeConnect = Effect.fn("slack.complete_connect")(function* (
    input: SlackCompleteConnectInput,
  ) {
    const url = yield* Effect.try({
      try: () => new URL(input.callbackUrl.trim()),
      catch: () => slackError("oauth", "Paste the full address from the page Slack opened."),
    });
    yield* handleRedirect(url);
    return snapshot(yield* Clock.currentTimeMillis).connection;
  });

  const cancelConnect = endAuthorization(false).pipe(Effect.andThen(publish));

  const disconnect = Effect.gen(function* () {
    const current = connection;
    if (current) {
      // Revoke so the token stops working, not only here.
      yield* postForm("auth.revoke", {}, current.accessToken).pipe(Effect.ignore);
    }
    yield* dropConnection(undefined);
  });

  const refresh = Effect.gen(function* () {
    channelsListedAt = 0;
    githubQueueAt = 0;
    followedRefreshedAt = 0;
    mentionsSearchedAt = 0;
    for (const channel of channels.values()) channel.nextPollAt = 0;
    yield* Deferred.succeed(wake, undefined);
  });

  const resetInbox = Effect.gen(function* () {
    const current = connection;
    if (!current) return yield* slackError("reset_inbox", "Slack is not connected.");
    const startedAtMs = yield* Clock.currentTimeMillis;
    yield* secrets
      .set(
        INBOX_START_SECRET,
        new TextEncoder().encode(
          encodeStoredInboxStart({
            teamUrl: current.teamUrl,
            userId: current.userId,
            startedAtMs,
          }),
        ),
      )
      .pipe(Effect.mapError(() => slackError("reset_inbox", "Could not save inbox reset.")));
    yield* secrets
      .remove(DISMISSED_SECRET)
      .pipe(Effect.mapError(() => slackError("reset_inbox", "Could not clear dismissed threads.")));
    inboxStartedAtMs = startedAtMs;
    dismissed = [];
    yield* secrets.remove(CACHE_SECRET).pipe(Effect.ignore);
    yield* startSync(false);
    yield* publish;
  });

  const getThread = Effect.fn("slack.get_thread")(function* (input: SlackGetThreadInput) {
    const ref = parseSlackThreadUrl(input.url);
    if (!ref) return yield* slackError("get_thread", "Paste a Slack message or thread link.");
    if (!connection)
      return yield* slackError("get_thread", "Connect Slack from the Job page first.");
    if (new URL(ref.url).hostname !== new URL(connection.teamUrl).hostname) {
      return yield* slackError(
        "get_thread",
        "This link belongs to a different Slack workspace. Connect that workspace first.",
      );
    }
    const info = yield* call("conversations.info", { channel: ref.channelId }, "interactive");
    const channel = info.channel as SlackApiChannel | undefined;
    if (!channel) return yield* slackError("get_thread", "Slack channel is unavailable.");
    const body = yield* call(
      "conversations.replies",
      { channel: ref.channelId, ts: ref.ts, limit: "200" },
      "interactive",
    );
    const messages = yield* resolveMessages(
      ref.channelId,
      (body.messages as SlackApiMessage[] | undefined) ?? [],
      "interactive",
    );
    const root = messages.find((message) => message.ts === ref.ts);
    if (!root)
      return yield* slackError("get_thread", "Slack thread was deleted or is not accessible.");
    return {
      thread: {
        ...root,
        channelName: channelDisplayName(channel),
        channelKind: channelKind(channel),
        permalink: ref.url,
      },
      replies: messages.filter((message) => message.ts !== ref.ts),
      hasMore:
        body.has_more === true ||
        Boolean((body.response_metadata as { next_cursor?: string } | undefined)?.next_cursor),
    };
  });

  const getReplies = Effect.fn("slack.get_replies")(function* (ref: SlackThreadRef) {
    const body = yield* call(
      "conversations.replies",
      { channel: ref.channelId, ts: ref.ts, limit: "200" },
      "interactive",
    );
    const replies = ((body.messages as SlackApiMessage[] | undefined) ?? []).filter(
      (message) => message.ts !== ref.ts,
    );
    return yield* resolveMessages(ref.channelId, replies, "interactive");
  });

  const setReaction = Effect.fn("slack.set_reaction")(function* (input: SlackSetReactionInput) {
    const method = input.reacted ? "reactions.add" : "reactions.remove";
    yield* call(
      method,
      { channel: input.channelId, timestamp: input.ts, name: input.name },
      "interactive",
    ).pipe(
      Effect.catchIf(
        (error) => error.message === "already_reacted" || error.message === "no_reaction",
        () => Effect.succeed(undefined),
      ),
    );
    reactionGeneration += 1;
    // Reacting to a mention answers it; the next reactions read settles removals.
    if (input.reacted) reactedKeys.add(`${input.channelId}:${input.ts}`);
    const added = () =>
      toReaction({ name: input.name, count: 1, users: [connection?.userId ?? ""] });
    // Patch the feed and your conversations now instead of waiting for the next read.
    const channel = channels.get(input.channelId);
    const feedThread = channel?.threads.find((candidate) => candidate.ts === input.ts);
    if (channel && feedThread) {
      channel.threads = channel.threads.map((candidate) =>
        candidate === feedThread
          ? {
              ...feedThread,
              reactions: patchReaction(feedThread.reactions, input.name, input.reacted, added),
            }
          : candidate,
      );
    }
    const key = conversationKey(input);
    let entry = conversations.get(key);
    if (entry?.thread) {
      entry.thread = {
        ...entry.thread,
        reactions: patchReaction(entry.thread.reactions, input.name, input.reacted, added),
      };
    }
    if (input.name === SLACK_FOLLOW_REACTION) {
      // The mark changed in Slack; read it back soon. The change shows right away.
      followedRefreshedAt = 0;
      if (input.reacted && (entry || feedThread)) {
        entry ??= conversationEntry(input);
        entry.followed = true;
        entry.nextReadAt = 0;
        const current = channel?.threads.find((candidate) => candidate.ts === input.ts);
        if (!entry.thread && current) entry.thread = current;
      } else if (!input.reacted && entry) {
        entry.followed = false;
        if (!entry.devin) conversations.delete(key);
      }
      yield* Deferred.succeed(wake, undefined);
    }
    yield* publish;
  });

  const setDismissed = Effect.fn("slack.set_dismissed")(function* (input: SlackSetDismissedInput) {
    yield* dismissedWrites.withPermit(
      Effect.gen(function* () {
        const current = connection;
        if (!current) return yield* slackError("set_dismissed", "Slack is not connected.");
        const present = dismissed.some(
          (thread) => thread.channelId === input.channelId && thread.ts === input.ts,
        );
        if (present === input.dismissed) return;
        const now = yield* Clock.currentTimeMillis;
        const recent = dismissed.filter((thread) =>
          dismissedKept(thread, now - DISMISSED_RETENTION_MS),
        );
        const next = input.dismissed
          ? [...recent, { channelId: input.channelId, ts: input.ts, at: now }]
          : recent.filter(
              (thread) => !(thread.channelId === input.channelId && thread.ts === input.ts),
            );
        yield* secrets
          .set(
            DISMISSED_SECRET,
            new TextEncoder().encode(
              encodeStoredDismissed({
                teamUrl: current.teamUrl,
                userId: current.userId,
                threads: next,
              }),
            ),
          )
          .pipe(
            Effect.mapError(() => slackError("set_dismissed", "Could not save dismissed threads.")),
          );
        dismissed = next;
        yield* publish;
      }),
    );
  });

  const setConversationOwner = Effect.fn("slack.set_conversation_owner")(function* (
    input: SlackSetConversationOwnerInput,
  ) {
    yield* ownerWrites.withPermit(
      Effect.gen(function* () {
        const current = connection;
        if (!current) return yield* slackError("set_owner", "Slack is not connected.");
        const others = conversationOwners.filter(
          (entry) => !(entry.channelId === input.channelId && entry.ts === input.ts),
        );
        const next = input.owner
          ? [...others, { channelId: input.channelId, ts: input.ts, ...input.owner }]
          : others;
        yield* secrets
          .set(
            OWNERS_SECRET,
            new TextEncoder().encode(
              encodeStoredOwners({
                teamUrl: current.teamUrl,
                userId: current.userId,
                owners: next,
              }),
            ),
          )
          .pipe(Effect.mapError(() => slackError("set_owner", "Could not save the owner.")));
        conversationOwners = next;
        yield* publish;
      }),
    );
  });

  const setConversationWait = Effect.fn("slack.set_conversation_wait")(function* (
    input: SlackSetConversationWaitInput,
  ) {
    yield* ownerWrites.withPermit(
      Effect.gen(function* () {
        const current = connection;
        if (!current) return yield* slackError("set_wait", "Slack is not connected.");
        const others = conversationWaits.filter(
          (entry) => !(entry.channelId === input.channelId && entry.ts === input.ts),
        );
        const next = input.member
          ? [
              ...others,
              {
                channelId: input.channelId,
                ts: input.ts,
                ...input.member,
                at: yield* Clock.currentTimeMillis,
              },
            ]
          : others;
        yield* secrets
          .set(
            WAITS_SECRET,
            new TextEncoder().encode(
              encodeStoredWaits({ teamUrl: current.teamUrl, userId: current.userId, waits: next }),
            ),
          )
          .pipe(Effect.mapError(() => slackError("set_wait", "Could not save who you wait on.")));
        conversationWaits = next;
        yield* publish;
      }),
    );
  });

  const writeDrafts = (current: StoredConnection, next: ReadonlyArray<ReplyDraft>) =>
    secrets
      .set(
        DRAFTS_SECRET,
        new TextEncoder().encode(
          encodeStoredDrafts({ teamUrl: current.teamUrl, userId: current.userId, drafts: next }),
        ),
      )
      .pipe(Effect.mapError(() => slackError("set_draft", "Could not save the draft.")));

  const setReplyDraft = Effect.fn("slack.set_reply_draft")(function* (
    input: SlackSetReplyDraftInput & { readonly by: "you" | "agent" },
  ) {
    yield* ownerWrites.withPermit(
      Effect.gen(function* () {
        const current = connection;
        if (!current) return yield* slackError("set_draft", "Slack is not connected.");
        const others = replyDrafts.filter(
          (draft) => !(draft.channelId === input.channelId && draft.ts === input.ts),
        );
        const text = input.text?.trim();
        const next = text
          ? [
              ...others,
              {
                channelId: input.channelId,
                ts: input.ts,
                text,
                by: input.by,
                at: yield* Clock.currentTimeMillis,
              },
            ]
          : others;
        yield* writeDrafts(current, next);
        replyDrafts = next;
        yield* publish;
      }),
    );
  });

  const sendReply = Effect.fn("slack.send_reply")(function* (input: SlackSendReplyInput) {
    if (!connection) return yield* slackError("send_reply", "Slack is not connected.");
    const posted = yield* call(
      "chat.postMessage",
      { channel: input.channelId, thread_ts: input.ts, text: input.text },
      "interactive",
    ).pipe(
      Effect.mapError((error) =>
        error.message === "missing_scope"
          ? slackError(
              "send_reply",
              "Sign in to Slack again in Settings → Work to reply from here.",
            )
          : error,
      ),
    );
    // Your reply answers any mention in the conversation right away.
    const postedTs = typeof posted.ts === "string" ? posted.ts : undefined;
    if (postedTs) {
      myHits = [
        {
          channelId: input.channelId,
          ts: input.ts,
          messageTs: postedTs,
          userId: connection.userId,
          direct: false,
          text: input.text,
          permalink: "",
        },
        ...myHits,
      ];
    }
    yield* setReplyDraft({ channelId: input.channelId, ts: input.ts, text: null, by: "you" });
    // Read the conversation back so it shows your reply and waits on the others.
    const entry = conversations.get(conversationKey(input));
    if (entry) entry.nextReadAt = 0;
    yield* Deferred.succeed(wake, undefined);
  });

  const getChannels = Effect.gen(function* () {
    if (!connection) return yield* slackError("get_channels", "Slack is not connected.");
    return [...channels.values()]
      .map((channel) => ({ id: channel.id, name: channel.name, kind: channel.kind }))
      .sort((left, right) => left.name.localeCompare(right.name));
  });

  const setChannelIncluded = Effect.fn("slack.set_channel_included")(function* (
    input: SlackSetChannelIncludedInput,
  ) {
    yield* channelWrites.withPermit(
      Effect.gen(function* () {
        const current = connection;
        if (!current) return yield* slackError("set_channel_included", "Slack is not connected.");
        const channel = channels.get(input.channelId);
        if (!channel) return yield* slackError("set_channel_included", "Channel is unavailable.");
        if (includedChannelIds.has(input.channelId) === input.included) return;
        const next = new Set(includedChannelIds);
        if (input.included) next.add(input.channelId);
        else next.delete(input.channelId);
        yield* secrets
          .set(
            INCLUDED_CHANNELS_SECRET,
            new TextEncoder().encode(
              encodeStoredIncludedChannels({
                teamUrl: current.teamUrl,
                userId: current.userId,
                channelIds: [...next],
              }),
            ),
          )
          .pipe(
            Effect.mapError(() =>
              slackError("set_channel_included", "Could not save your channels."),
            ),
          );
        includedChannelIds = next;
        channel.threads = [];
        channel.synced = false;
        channel.nextPollAt = 0;
        yield* publish;
        if (input.included) yield* Deferred.succeed(wake, undefined);
      }),
    );
  });

  const unfollow = Effect.fn("slack.unfollow")(function* (ref: SlackThreadRef) {
    const current = connection;
    if (!current) return yield* slackError("unfollow", "Slack is not connected.");
    const marked: string[] = [];
    let cursor = "";
    for (let page = 0; page < 3; page += 1) {
      const body = yield* call(
        "reactions.list",
        { user: current.userId, full: "true", limit: "200", ...(cursor ? { cursor } : {}) },
        "interactive",
      );
      for (const item of (body.items as SlackApiReactionItem[] | undefined) ?? []) {
        const message = item.message;
        if (item.type !== "message" || item.channel !== ref.channelId || !message) continue;
        if ((message.thread_ts ?? message.ts) !== ref.ts) continue;
        if (
          message.reactions?.some(
            (reaction) =>
              reaction.name === SLACK_FOLLOW_REACTION && reaction.users?.includes(current.userId),
          )
        )
          marked.push(message.ts);
      }
      cursor = (body.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "";
      if (!cursor) break;
    }
    for (const ts of marked) {
      yield* call(
        "reactions.remove",
        { channel: ref.channelId, timestamp: ts, name: SLACK_FOLLOW_REACTION },
        "interactive",
      ).pipe(
        Effect.catchIf(
          (error) => error.message === "no_reaction",
          () => Effect.void,
        ),
      );
    }
    reactionGeneration += 1;
    if (marked.includes(ref.ts)) {
      const unmark = (reactions: ReadonlyArray<SlackReaction>) =>
        patchReaction(reactions, SLACK_FOLLOW_REACTION, false);
      const channel = channels.get(ref.channelId);
      if (channel) {
        channel.threads = channel.threads.map((thread) =>
          thread.ts === ref.ts ? { ...thread, reactions: unmark(thread.reactions) } : thread,
        );
      }
      const entry = conversations.get(conversationKey(ref));
      if (entry?.thread)
        entry.thread = { ...entry.thread, reactions: unmark(entry.thread.reactions) };
    }
    const entry = conversations.get(conversationKey(ref));
    if (entry) {
      entry.followed = false;
      if (!entry.devin) conversations.delete(conversationKey(ref));
    }
    followedRefreshedAt = 0;
    yield* Deferred.succeed(wake, undefined);
    yield* publish;
  });

  const devinConnect = Effect.fn("slack.devin_connect")(function* (input: DevinConnectInput) {
    const apiKey = input.apiKey.trim();
    const self = yield* devinRequest(apiKey, "/v3/self").pipe(
      Effect.mapError((error) =>
        slackError(
          "devin_connect",
          error.message === "not_found" ? "Devin did not recognize the key." : error.message,
        ),
      ),
    );
    const orgId = typeof self.org_id === "string" ? self.org_id : undefined;
    if (!orgId) {
      return yield* slackError(
        "devin_connect",
        "This key is not tied to a Devin organization. Create one in your organization's settings.",
      );
    }
    const name = [self.user_name, self.service_user_name, self.api_key_name].find(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    const next: StoredDevin = { apiKey, orgId, name: name ?? "Devin" };
    yield* secrets
      .set(DEVIN_SECRET, new TextEncoder().encode(encodeStoredDevin(next)))
      .pipe(Effect.mapError(() => slackError("devin_connect", "Could not save the Devin key.")));
    devin = next;
    devinError = undefined;
    devinSessions.clear();
    devinSessionsCheckedAt = 0;
    yield* Deferred.succeed(wake, undefined);
    yield* publish;
    return snapshot(yield* Clock.currentTimeMillis).devin;
  });

  const setAppToken = Effect.fn("slack.set_app_token")(function* (input: SlackSetAppTokenInput) {
    if (input.token === null) {
      yield* secrets.remove(APP_TOKEN_SECRET).pipe(Effect.ignore);
      appToken = undefined;
      yield* stopEvents;
      yield* catchUp;
      yield* publish;
      return;
    }
    if (!connection) return yield* slackError("set_app_token", "Connect Slack first.");
    const token = input.token.trim();
    // Opening a connection is the only check an app-level token has.
    yield* openSocketUrl(token).pipe(
      Effect.mapError((error) =>
        slackError(
          "set_app_token",
          slackSocketErrorIsFinal(error.message)
            ? "Slack did not accept this token. Generate an app-level token with connections:write."
            : error.message,
        ),
      ),
    );
    yield* secrets
      .set(APP_TOKEN_SECRET, new TextEncoder().encode(token))
      .pipe(Effect.mapError(() => slackError("set_app_token", "Could not save the token.")));
    appToken = token;
    yield* startEvents;
    yield* publish;
  });

  const devinDisconnect = Effect.gen(function* () {
    yield* secrets.remove(DEVIN_SECRET).pipe(Effect.ignore);
    devin = undefined;
    devinError = undefined;
    devinSessions.clear();
    yield* publish;
  });

  const listMembers = Effect.gen(function* () {
    if (!connection) return yield* slackError("list_members", "Slack is not connected.");
    const now = yield* Clock.currentTimeMillis;
    if (members && now - members.at < MEMBERS_TTL_MS) return members.list;
    const listed: SlackApiUser[] = [];
    let cursor = "";
    for (let page = 0; page < MEMBERS_MAX_PAGES; page += 1) {
      const body = yield* call(
        "users.list",
        { limit: "200", ...(cursor ? { cursor } : {}) },
        "interactive",
      );
      listed.push(...((body.members as SlackApiUser[] | undefined) ?? []));
      cursor = (body.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "";
      if (!cursor) break;
    }
    const list = listed
      .filter(isMember)
      .map((user): SlackMember => {
        const name = userDisplayName(user);
        const avatarUrl = user.profile?.image_48;
        users.set(user.id, { name, ...(avatarUrl ? { avatarUrl } : {}) });
        return { userId: user.id, name, ...(avatarUrl ? { avatarUrl } : {}) };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
    members = { at: now, list };
    return list;
  }).pipe(Effect.withSpan("slack.list_members"));

  const stored = yield* secrets.get(CONNECTION_SECRET).pipe(
    Effect.map(Option.flatMap((bytes) => decodeStoredConnection(new TextDecoder().decode(bytes)))),
    Effect.orElseSucceed(() => Option.none<StoredConnection>()),
  );
  const storedClientId = yield* secrets.get(CLIENT_ID_SECRET).pipe(
    Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes).trim())),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  if (Option.isSome(storedClientId) && storedClientId.value) lastClientId = storedClientId.value;
  const storedDevin = yield* secrets.get(DEVIN_SECRET).pipe(
    Effect.map(Option.flatMap((bytes) => decodeStoredDevin(new TextDecoder().decode(bytes)))),
    Effect.orElseSucceed(() => Option.none<StoredDevin>()),
  );
  if (Option.isSome(storedDevin)) devin = storedDevin.value;
  const storedAppToken = yield* secrets.get(APP_TOKEN_SECRET).pipe(
    Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes).trim())),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  if (Option.isSome(storedAppToken) && storedAppToken.value) appToken = storedAppToken.value;
  // What was read survives a restart; the next start picks up from it.
  yield* Effect.addFinalizer(() => saveCache);
  if (Option.isSome(stored)) {
    connection = stored.value;
    yield* loadDismissed;
    yield* loadIncludedChannels;
    yield* loadOwners;
    yield* loadWaits;
    yield* loadDrafts;
    yield* loadInboxStart;
    lastClientId = stored.value.clientId;
    yield* startSync(true);
  }
  yield* publish;

  const imageResponse = Effect.fn("slack.image_response")(function* (url: string) {
    let current = connection;
    if (!current) return yield* slackError("image", "Slack is not connected.");
    if (
      current.expiresAtMs !== undefined &&
      current.expiresAtMs - 5 * 60_000 < (yield* Clock.currentTimeMillis)
    ) {
      current = yield* refreshAccessToken(current);
    }
    return yield* slackImageResponse(url, current.accessToken).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.timeout("20 seconds"),
      Effect.mapError(() => slackError("image", "The Slack image could not be loaded.")),
    );
  });

  return SlackService.of({
    state: SubscriptionRef.changes(stateRef),
    current: SubscriptionRef.get(stateRef),
    connect,
    completeConnect,
    cancelConnect,
    disconnect,
    refresh,
    resetInbox,
    getThread,
    getReplies,
    imageResponse,
    setReaction,
    unfollow,
    setDismissed,
    setConversationOwner,
    setConversationWait,
    setReplyDraft,
    sendReply,
    getChannels,
    setChannelIncluded,
    listMembers,
    setAppToken,
    devinConnect,
    devinDisconnect,
  });
});

/** Without a WebSocket client, for tests that stand in for Slack's Socket Mode. */
export const layerWithoutWebSocket = Layer.effect(SlackService, make);

export const layer = layerWithoutWebSocket.pipe(
  Layer.provide(NodeSocket.layerWebSocketConstructor),
);
