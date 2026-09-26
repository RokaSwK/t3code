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
 * @module SlackService
 */
// @effect-diagnostics nodeBuiltinImport:off - the sign-in loopback listens on a Node HTTP server.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  SLACK_FOLLOW_REACTION,
  SLACK_OAUTH_REDIRECT_URI,
  SLACK_OAUTH_LOOPBACK_PORT,
  SLACK_USER_SCOPES,
  SlackError,
  parseSlackThreadUrl,
  type SlackGetThreadInput,
  type SlackThreadDetail,
  type SlackChannelKind,
  type SlackCompleteConnectInput,
  type SlackConnectInput,
  type SlackConnection,
  type SlackMember,
  type SlackMessage,
  type SlackReaction,
  type SlackSetReactionInput,
  type SlackSetDismissedInput,
  type SlackSetChannelExcludedInput,
  type SlackChannel,
  type SlackState,
  SlackThread,
  SlackThreadRef,
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

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  isSlackThreadRoot,
  SLACK_CHANNEL_LIST_INTERVAL_MS,
  SLACK_FEED_WINDOW_MS,
  SLACK_FOLLOWED_INTERVAL_MS,
  slackFeedOrder,
  slackFollowedRefs,
  type SlackApiReactionItem,
  type SlackFollowedRef,
  slackLatestActivityMs,
  slackPermalink,
  slackPollDelayMs,
  type SlackApiMessage,
} from "./slackFeed.ts";
import { slackMentionedUserIds, slackMrkdwnToMarkdown, standardEmoji } from "./slackMrkdwn.ts";
import { SlackRateLimiter, type SlackCallPriority } from "./slackRateLimiter.ts";

const CONNECTION_SECRET = "slack-connection";
/** The app last signed in with, kept across sign-outs so reconnecting is one click. */
const CLIENT_ID_SECRET = "slack-client-id";
const DISMISSED_SECRET = "slack-dismissed-threads";
const EXCLUDED_CHANNELS_SECRET = "slack-excluded-channels";
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
type StoredConnection = typeof StoredConnection.Type;
const decodeStoredConnection = Schema.decodeUnknownOption(Schema.fromJsonString(StoredConnection));
const encodeStoredConnection = Schema.encodeSync(Schema.fromJsonString(StoredConnection));
const StoredDismissed = Schema.Struct({
  teamUrl: Schema.String,
  userId: Schema.String,
  threads: Schema.Array(SlackThreadRef),
});
const decodeStoredDismissed = Schema.decodeUnknownOption(Schema.fromJsonString(StoredDismissed));
const encodeStoredDismissed = Schema.encodeSync(Schema.fromJsonString(StoredDismissed));
const StoredExcludedChannels = Schema.Struct({
  teamUrl: Schema.String,
  userId: Schema.String,
  channelIds: Schema.Array(Schema.String),
});
const decodeStoredExcludedChannels = Schema.decodeUnknownOption(
  Schema.fromJsonString(StoredExcludedChannels),
);
const encodeStoredExcludedChannels = Schema.encodeSync(
  Schema.fromJsonString(StoredExcludedChannels),
);

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
    readonly connect: (input: SlackConnectInput) => Effect.Effect<SlackConnection, SlackError>;
    readonly completeConnect: (
      input: SlackCompleteConnectInput,
    ) => Effect.Effect<SlackConnection, SlackError>;
    readonly cancelConnect: Effect.Effect<void>;
    readonly disconnect: Effect.Effect<void>;
    readonly refresh: Effect.Effect<void>;
    readonly getThread: (
      input: SlackGetThreadInput,
    ) => Effect.Effect<SlackThreadDetail, SlackError>;
    readonly getReplies: (
      ref: SlackThreadRef,
    ) => Effect.Effect<ReadonlyArray<SlackMessage>, SlackError>;
    readonly setReaction: (input: SlackSetReactionInput) => Effect.Effect<void, SlackError>;
    readonly unfollow: (ref: SlackThreadRef) => Effect.Effect<void, SlackError>;
    readonly setDismissed: (input: SlackSetDismissedInput) => Effect.Effect<void, SlackError>;
    readonly getChannels: Effect.Effect<ReadonlyArray<SlackChannel>, SlackError>;
    readonly setChannelExcluded: (
      input: SlackSetChannelExcludedInput,
    ) => Effect.Effect<void, SlackError>;
    /** Workspace members, cached; who a T3 thread can be assigned to. */
    readonly listMembers: Effect.Effect<ReadonlyArray<SlackMember>, SlackError>;
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

const encodeThreads = Schema.encodeSync(Schema.fromJsonString(Schema.Array(SlackThread)));
/** Reads mostly return what we already have; only a real change is published. */
function sameThreads(left: ReadonlyArray<SlackThread>, right: ReadonlyArray<SlackThread>) {
  return left.length === right.length && encodeThreads(left) === encodeThreads(right);
}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
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
  /** Custom emoji name to image URL, or `alias:<name>`. */
  let customEmoji = new Map<string, string>();
  let channelsListedAt = 0;
  let lastSyncedAt: number | undefined;
  let syncError: string | undefined;
  let dirty = false;
  let publishedAt = 0;
  /** Threads marked with the follow reaction, newest first. */
  let followed: ReadonlyArray<SlackThread> = [];
  let dismissed: ReadonlyArray<SlackThreadRef> = [];
  const dismissedWrites = yield* Semaphore.make(1);
  let excludedChannelIds = new Set<string>();
  const exclusionWrites = yield* Semaphore.make(1);
  let followedRefreshedAt = 0;
  /** Conversations followed threads live in that are not in the polled channel set. */
  const followedChannels = new Map<
    string,
    { readonly name: string; readonly kind: SlackChannelKind }
  >();
  let members: { readonly at: number; readonly list: ReadonlyArray<SlackMember> } | undefined;

  const snapshot = (now: number): SlackState => {
    const rateLimitedUntil = limiter.pausedUntilMs(now);
    const connectionState: SlackConnection = connection
      ? {
          status: "connected",
          clientId: connection.clientId,
          teamName: connection.teamName,
          teamUrl: connection.teamUrl,
          userId: connection.userId,
          userName: connection.userName,
        }
      : authorization
        ? {
            status: "authorizing",
            clientId: authorization.clientId,
            authorizeUrl: authorization.authorizeUrl,
            ...(connectionError ? { error: connectionError } : {}),
          }
        : {
            status: "disconnected",
            ...(lastClientId ? { clientId: lastClientId } : {}),
            ...(connectionError ? { error: connectionError } : {}),
          };
    const channelStates = [...channels.values()].filter(
      (channel) => !excludedChannelIds.has(channel.id),
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
        : [],
      followed: connection ? followed : [],
      dismissed: connection ? dismissed : [],
      excludedChannelIds: connection ? [...excludedChannelIds] : [],
    };
  };

  const stateRef = yield* SubscriptionRef.make<SlackState>(
    snapshot(yield* Clock.currentTimeMillis),
  );
  const publish = Effect.gen(function* () {
    dirty = false;
    publishedAt = yield* Clock.currentTimeMillis;
    yield* SubscriptionRef.set(stateRef, snapshot(publishedAt));
  });

  const loadDismissed = Effect.gen(function* () {
    const cutoff = (yield* Clock.currentTimeMillis) - SLACK_FEED_WINDOW_MS;
    const stored = yield* secrets.get(DISMISSED_SECRET).pipe(
      Effect.map(Option.flatMap((bytes) => decodeStoredDismissed(new TextDecoder().decode(bytes)))),
      Effect.orElseSucceed(() => Option.none<typeof StoredDismissed.Type>()),
    );
    dismissed =
      connection &&
      Option.isSome(stored) &&
      stored.value.teamUrl === connection.teamUrl &&
      stored.value.userId === connection.userId
        ? stored.value.threads.filter((thread) => Number.parseFloat(thread.ts) * 1000 > cutoff)
        : [];
  });

  const loadExcludedChannels = Effect.gen(function* () {
    const stored = yield* secrets.get(EXCLUDED_CHANNELS_SECRET).pipe(
      Effect.map(
        Option.flatMap((bytes) => decodeStoredExcludedChannels(new TextDecoder().decode(bytes))),
      ),
      Effect.orElseSucceed(() => Option.none<typeof StoredExcludedChannels.Type>()),
    );
    excludedChannelIds = new Set(
      connection &&
        Option.isSome(stored) &&
        stored.value.teamUrl === connection.teamUrl &&
        stored.value.userId === connection.userId
        ? stored.value.channelIds
        : [],
    );
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
    const body = yield* call(
      "conversations.history",
      {
        channel: channel.id,
        oldest: String((now - SLACK_FEED_WINDOW_MS) / 1000),
        limit: "100",
      },
      "background",
    );
    const messages = ((body.messages as SlackApiMessage[] | undefined) ?? []).filter(
      isSlackThreadRoot,
    );
    const resolved = yield* resolveMessages(channel.id, messages, "background");
    const teamUrl = connection?.teamUrl ?? "https://slack.com/";
    const threads = resolved.map((message): SlackThread => ({
      ...message,
      channelName: channel.name,
      channelKind: channel.kind,
      permalink: slackPermalink(teamUrl, channel.id, message.ts),
    }));
    if (!channel.synced || !sameThreads(threads, channel.threads)) {
      channel.threads = threads;
      dirty = true;
    }
    channel.synced = true;
    channel.nextPollAt = now + slackPollDelayMs(slackLatestActivityMs(messages), now);
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

  const followedThread = Effect.fn("slack.followed_thread")(function* (
    ref: SlackFollowedRef,
    priority: SlackCallPriority,
  ) {
    const channel = yield* describeChannel(ref.channelId, priority);
    let root = ref.root;
    // A followed reply, or a root without its reply count, needs the conversation itself.
    if (!root || root.reply_count === undefined) {
      const body = yield* call(
        "conversations.replies",
        { channel: ref.channelId, ts: ref.ts, limit: "1" },
        priority,
      );
      root = ((body.messages as SlackApiMessage[] | undefined) ?? []).find(
        (message) => message.ts === ref.ts,
      );
    }
    if (!root) return undefined;
    const [message] = yield* resolveMessages(ref.channelId, [root], priority);
    if (!message) return undefined;
    const thread: SlackThread = {
      ...message,
      channelName: channel.name,
      channelKind: channel.kind,
      permalink: slackPermalink(connection?.teamUrl ?? "https://slack.com/", ref.channelId, ref.ts),
    };
    return thread;
  });

  /** Re-reads the user's reactions; the follow mark lives in Slack, not here. */
  const refreshFollowed = Effect.fn("slack.refresh_followed")(function* (
    priority: SlackCallPriority,
  ) {
    const current = connection;
    if (!current) return;
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
    const refs = slackFollowedRefs(items, current.userId, SLACK_FOLLOW_REACTION);
    const threads: SlackThread[] = [];
    for (const ref of refs) {
      // One unreadable conversation should not hide the rest.
      const thread = yield* followedThread(ref, priority).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (thread) threads.push(thread);
    }
    if (!sameThreads(threads, followed)) {
      followed = threads;
      dirty = true;
    }
    followedRefreshedAt = yield* Clock.currentTimeMillis;
  });

  const syncLoop = Effect.gen(function* () {
    for (;;) {
      const now = yield* Clock.currentTimeMillis;
      if (now - followedRefreshedAt >= SLACK_FOLLOWED_INTERVAL_MS) {
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
      let due: ChannelState | undefined;
      for (const channel of channels.values()) {
        if (excludedChannelIds.has(channel.id)) continue;
        if (due === undefined || channel.nextPollAt < due.nextPollAt) due = channel;
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
        channelsListedAt + SLACK_CHANNEL_LIST_INTERVAL_MS,
        followedRefreshedAt + SLACK_FOLLOWED_INTERVAL_MS,
      );
      yield* Effect.raceFirst(
        Effect.sleep(Duration.millis(Math.max(1_000, nextAt - now))),
        Deferred.await(wake),
      );
      if (yield* Deferred.isDone(wake)) wake = yield* Deferred.make<void>();
    }
  });

  const stopSync = Effect.suspend(() => {
    const fiber = syncFiber;
    syncFiber = undefined;
    return fiber ? Fiber.interrupt(fiber) : Effect.void;
  });

  const startSync = Effect.gen(function* () {
    yield* stopSync;
    channels.clear();
    users.clear();
    customEmoji = new Map();
    channelsListedAt = 0;
    lastSyncedAt = undefined;
    syncError = undefined;
    followed = [];
    followedRefreshedAt = 0;
    followedChannels.clear();
    members = undefined;
    syncFiber = yield* syncLoop.pipe(Effect.forkIn(layerScope));
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
      followed = [];
      dismissed = [];
      excludedChannelIds = new Set();
      members = undefined;
      yield* secrets.remove(CONNECTION_SECRET).pipe(Effect.ignore);
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
    yield* loadExcludedChannels;
    connectionError = undefined;
    lastClientId = next.clientId;
    if (authorization === pending) yield* endAuthorization(true);
    yield* startSync;
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
    followedRefreshedAt = 0;
    for (const channel of channels.values()) channel.nextPollAt = 0;
    yield* Deferred.succeed(wake, undefined);
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
    if (input.name === SLACK_FOLLOW_REACTION) {
      // The mark changed in Slack; read it back soon. Unfollowing hides the thread right away.
      followedRefreshedAt = 0;
      if (!input.reacted) {
        followed = followed.filter(
          (candidate) => !(candidate.channelId === input.channelId && candidate.ts === input.ts),
        );
        dirty = true;
      }
      yield* Deferred.succeed(wake, undefined);
    }
    // Patch the feed now instead of waiting for the next read of the channel.
    const channel = channels.get(input.channelId);
    const thread = channel?.threads.find((candidate) => candidate.ts === input.ts);
    if (!channel || !thread) {
      if (dirty) yield* publish;
      return;
    }
    const existing = thread.reactions.find((reaction) => reaction.name === input.name);
    const reactions = existing
      ? thread.reactions
          .map((reaction) =>
            reaction.name === input.name && reaction.reacted !== input.reacted
              ? {
                  ...reaction,
                  reacted: input.reacted,
                  count: reaction.count + (input.reacted ? 1 : -1),
                }
              : reaction,
          )
          .filter((reaction) => reaction.count > 0)
      : input.reacted
        ? [
            ...thread.reactions,
            toReaction({ name: input.name, count: 1, users: [connection?.userId ?? ""] }),
          ]
        : thread.reactions;
    channel.threads = channel.threads.map((candidate) =>
      candidate === thread ? { ...thread, reactions } : candidate,
    );
    if (input.name === SLACK_FOLLOW_REACTION && input.reacted) {
      // Show it under Following right away; the next read confirms it.
      const marked = { ...thread, reactions };
      followed = slackFeedOrder([
        marked,
        ...followed.filter(
          (candidate) => !(candidate.channelId === marked.channelId && candidate.ts === marked.ts),
        ),
      ]);
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
        const cutoff = (yield* Clock.currentTimeMillis) - SLACK_FEED_WINDOW_MS;
        const recent = dismissed.filter((thread) => Number.parseFloat(thread.ts) * 1000 > cutoff);
        const next = input.dismissed
          ? [...recent, { channelId: input.channelId, ts: input.ts }]
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

  const getChannels = Effect.gen(function* () {
    if (!connection) return yield* slackError("get_channels", "Slack is not connected.");
    return [...channels.values()]
      .map((channel) => ({ id: channel.id, name: channel.name, kind: channel.kind }))
      .sort((left, right) => left.name.localeCompare(right.name));
  });

  const setChannelExcluded = Effect.fn("slack.set_channel_excluded")(function* (
    input: SlackSetChannelExcludedInput,
  ) {
    yield* exclusionWrites.withPermit(
      Effect.gen(function* () {
        const current = connection;
        if (!current) return yield* slackError("set_channel_excluded", "Slack is not connected.");
        const channel = channels.get(input.channelId);
        if (!channel) return yield* slackError("set_channel_excluded", "Channel is unavailable.");
        if (excludedChannelIds.has(input.channelId) === input.excluded) return;
        const next = new Set(excludedChannelIds);
        if (input.excluded) next.add(input.channelId);
        else next.delete(input.channelId);
        yield* secrets
          .set(
            EXCLUDED_CHANNELS_SECRET,
            new TextEncoder().encode(
              encodeStoredExcludedChannels({
                teamUrl: current.teamUrl,
                userId: current.userId,
                channelIds: [...next],
              }),
            ),
          )
          .pipe(
            Effect.mapError(() =>
              slackError("set_channel_excluded", "Could not save channel exclusions."),
            ),
          );
        excludedChannelIds = next;
        channel.threads = [];
        channel.synced = false;
        channel.nextPollAt = 0;
        yield* publish;
        if (!input.excluded) yield* Deferred.succeed(wake, undefined);
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
    if (marked.includes(ref.ts)) {
      const channel = channels.get(ref.channelId);
      if (channel) {
        channel.threads = channel.threads.map((thread) =>
          thread.ts === ref.ts
            ? {
                ...thread,
                reactions: thread.reactions
                  .map((reaction) =>
                    reaction.name === SLACK_FOLLOW_REACTION && reaction.reacted
                      ? { ...reaction, reacted: false, count: reaction.count - 1 }
                      : reaction,
                  )
                  .filter((reaction) => reaction.count > 0),
              }
            : thread,
        );
      }
    }
    followed = followed.filter(
      (thread) => !(thread.channelId === ref.channelId && thread.ts === ref.ts),
    );
    followedRefreshedAt = 0;
    yield* Deferred.succeed(wake, undefined);
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
  if (Option.isSome(stored)) {
    connection = stored.value;
    yield* loadDismissed;
    yield* loadExcludedChannels;
    lastClientId = stored.value.clientId;
    yield* startSync;
  }
  yield* publish;

  return SlackService.of({
    state: SubscriptionRef.changes(stateRef),
    connect,
    completeConnect,
    cancelConnect,
    disconnect,
    refresh,
    getThread,
    getReplies,
    setReaction,
    unfollow,
    setDismissed,
    getChannels,
    setChannelExcluded,
    listMembers,
  });
});

export const layer = Layer.effect(SlackService, make);
