import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { SLACK_OAUTH_REDIRECT_URI, type SlackState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as SlackService from "./SlackService.ts";

interface SlackCall {
  readonly method: string;
  readonly params: URLSearchParams;
  readonly token: string | undefined;
}

// @effect-diagnostics-next-line globalDate:off - the service reads Slack's recent window live.
const nowTs = (offsetSeconds: number) => (Date.now() / 1000 + offsetSeconds).toFixed(6);

/**
 * A small Slack workspace: one channel with a thread, a reply, and a join notice, plus two
 * Devin threads: one you started in #bugs, and one someone else started in #random.
 */
function fakeSlack(
  calls: Array<SlackCall>,
  rateLimited: Set<string>,
  options: { readonly searchError?: string } = {},
) {
  const root = nowTs(-600);
  const reply = nowTs(-300);
  const devinRoot = nowTs(-900);
  const devinReply = nowTs(-800);
  const otherRoot = nowTs(-700);
  const session = "0123456789abcdef0123456789abcdef";
  const devinThreads: Record<string, unknown[]> = {
    [`C2:${devinRoot}`]: [
      { ts: devinRoot, user: "U1", text: "<@UDEVIN> fix the login bug", reply_count: 1 },
      {
        ts: devinReply,
        thread_ts: devinRoot,
        user: "UDEVIN",
        bot_id: "BDEVIN",
        text: `PR: <https://github.com/acme/app/pull/8> [[↗︎]](<https://app.devin.ai/sessions/${session}?ts=1>)`,
      },
    ],
    [`C3:${otherRoot}`]: [
      { ts: otherRoot, user: "U2", text: "<@UDEVIN> look at this", reply_count: 1 },
      {
        ts: nowTs(-650),
        thread_ts: otherRoot,
        user: "UDEVIN",
        text: "On it [[↗︎]](<https://app.devin.ai/sessions/ffffffffffffffffffffffffffffffff?ts=1>)",
      },
    ],
  };
  const responses: Record<string, unknown> = {
    "oauth.v2.access": {
      ok: true,
      authed_user: { id: "U1", access_token: "xoxp-test" },
      team: { name: "Acme" },
    },
    "auth.test": { ok: true, url: "https://acme.slack.com/", team: "Acme", user: "ada" },
    "users.conversations": {
      ok: true,
      channels: [{ id: "C1", name: "general" }],
      response_metadata: { next_cursor: "" },
    },
    "emoji.list": {
      ok: true,
      emoji: { partyblob: "https://emoji.test/p.gif", blob: "alias:partyblob" },
    },
    "conversations.history": {
      ok: true,
      messages: [
        { ts: nowTs(-60), subtype: "channel_join", user: "U2", text: "joined" },
        { ts: reply, thread_ts: root, user: "U1", text: "reply" },
        {
          ts: root,
          thread_ts: root,
          user: "U2",
          text: "*ship* it <@U1> :blob: <https://github.com/acme/app/pull/7|acme/app#7>",
          reply_count: 1,
          latest_reply: reply,
          reactions: [{ name: "blob", count: 1, users: ["U2"] }],
        },
      ],
    },
    "conversations.info": { ok: true, channel: { id: "C1", name: "general" } },
    "conversations.replies": {
      ok: true,
      messages: [
        { ts: root, user: "U2", text: "root", reply_count: 1, latest_reply: reply },
        { ts: reply, thread_ts: root, user: "U1", text: "reply" },
      ],
    },
    "users.info": { ok: true },
    "reactions.add": { ok: true },
    "reactions.remove": { ok: true },
    // A thread the user marked with :eyes: in a direct message they do not poll, plus a mark
    // on a reply that must resolve to its parent in #general.
    "reactions.list": {
      ok: true,
      items: [
        {
          type: "message",
          channel: "D9",
          message: {
            ts: "1700000000.000100",
            user: "U2",
            text: "look at this",
            reply_count: 0,
            reactions: [{ name: "eyes", count: 1, users: ["U1"] }],
          },
        },
        {
          type: "message",
          channel: "C1",
          message: {
            ts: reply,
            thread_ts: root,
            user: "U1",
            text: "reply",
            reactions: [{ name: "eyes", count: 1, users: ["U1"] }],
          },
        },
      ],
      response_metadata: { next_cursor: "" },
    },
    "search.messages": options.searchError
      ? { ok: false, error: options.searchError }
      : {
          ok: true,
          messages: {
            matches: [
              {
                ts: devinReply,
                channel: { id: "C2" },
                permalink: `https://acme.slack.com/archives/C2/p1?thread_ts=${devinRoot}&cid=C2`,
              },
              {
                ts: otherRoot,
                channel: { id: "C3" },
                permalink: "https://acme.slack.com/archives/C3/p1",
              },
            ],
            paging: { pages: 1 },
          },
        },
    "users.list": {
      ok: true,
      members: [
        {
          id: "UDEVIN",
          is_bot: true,
          profile: { display_name: "Devin", bot_id: "BDEVIN", api_app_id: "A06A3TU8H39" },
        },
        { id: "U2", profile: { display_name: "Bo", image_48: "https://a.test/bo.png" } },
        { id: "U1", profile: { display_name: "Ada" } },
        { id: "B1", is_bot: true, profile: { display_name: "Robot" } },
        { id: "U3", deleted: true, profile: { display_name: "Gone" } },
        { id: "USLACKBOT", profile: { display_name: "Slackbot" } },
      ],
      response_metadata: { next_cursor: "" },
    },
  };
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        if (request.url.startsWith("https://api.devin.ai/")) {
          const path = request.url.replace("https://api.devin.ai", "");
          calls.push({
            method: `devin:${path}`,
            params: new URLSearchParams(),
            token: request.headers.authorization?.replace("Bearer ", ""),
          });
          const devinBody =
            path === "/v3/self"
              ? { principal_type: "user", org_id: "org-1", user_name: "ada" }
              : path === `/v3/organizations/org-1/sessions/devin-${session}`
                ? {
                    session_id: `devin-${session}`,
                    status: "running",
                    status_detail: "waiting_for_user",
                    title: "Fix the login bug",
                    pull_requests: [
                      { pr_url: "https://github.com/acme/app/pull/9", pr_state: "open" },
                    ],
                  }
                : null;
          return HttpClientResponse.fromWeb(
            request,
            // @effect-diagnostics-next-line preferSchemaOverJson:off - canned Devin response.
            new Response(devinBody ? JSON.stringify(devinBody) : null, {
              status: devinBody ? 200 : 404,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        const method = request.url.replace("https://slack.com/api/", "");
        const params = new URLSearchParams(
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        );
        calls.push({
          method,
          params,
          token: request.headers.authorization?.replace("Bearer ", ""),
        });
        if (rateLimited.delete(method)) {
          return HttpClientResponse.fromWeb(
            request,
            new Response(null, { status: 429, headers: { "retry-after": "1" } }),
          );
        }
        const thread = devinThreads[`${params.get("channel")}:${params.get("ts")}`];
        const body =
          method === "conversations.info" && params.get("channel") === "D9"
            ? { ok: true, channel: { id: "D9", is_im: true, user: "U2" } }
            : method === "conversations.info" && ["C2", "C3"].includes(params.get("channel") ?? "")
              ? {
                  ok: true,
                  channel: {
                    id: params.get("channel"),
                    name: params.get("channel") === "C2" ? "bugs" : "random",
                  },
                }
              : method === "conversations.replies" && thread
                ? { ok: true, messages: thread }
                : method === "conversations.replies" && params.get("channel") === "D9"
                  ? {
                      ok: true,
                      messages: [
                        {
                          ts: "1700000000.000100",
                          user: "U2",
                          text: "look at this",
                          reply_count: 0,
                        },
                      ],
                    }
                  : method === "users.info"
                    ? {
                        ok: true,
                        user: {
                          id: params.get("user"),
                          profile: { display_name: params.get("user") === "U1" ? "Ada" : "Bo" },
                        },
                      }
                    : (responses[method] ?? { ok: false, error: "unknown_method" });
        return HttpClientResponse.fromWeb(
          request,
          // @effect-diagnostics-next-line preferSchemaOverJson:off - canned Slack response.
          new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
        );
      }),
    ),
  );
}

/** GitHub reports every linked PR as merged. */
const fakeGitHub = Layer.mock(GitHubCli.GitHubCli)({
  execute: (input) =>
    Effect.succeed({
      exitCode: ChildProcessSpawner.ExitCode(0),
      stdout: JSON.stringify({
        data: Object.fromEntries(
          [...(input.args.at(-1) ?? "").matchAll(/(p\d+): resource/g)].map((match) => [
            match[1],
            { state: "MERGED" },
          ]),
        ),
      }),
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    }),
});

function memorySecrets(store = new Map<string, Uint8Array>()) {
  return Layer.mock(ServerSecretStore.ServerSecretStore)({
    get: (name) => Effect.succeed(Option.fromNullishOr(store.get(name))),
    set: (name, value) => Effect.sync(() => void store.set(name, value)),
    remove: (name) => Effect.sync(() => void store.delete(name)),
  });
}

const waitForState = (predicate: (state: SlackState) => boolean) =>
  Effect.gen(function* () {
    const slack = yield* SlackService.SlackService;
    const state = yield* slack.state.pipe(Stream.filter(predicate), Stream.runHead);
    return Option.getOrThrow(state);
  });

describe("SlackService", () => {
  it.live("resets the inbox from now and keeps the Slack connection", () => {
    const secrets = new Map<string, Uint8Array>([
      [
        "slack-connection",
        new TextEncoder().encode(
          JSON.stringify({
            clientId: "123.456",
            accessToken: "xoxp-test",
            teamName: "Acme",
            teamUrl: "https://acme.slack.com/",
            userId: "U1",
            userName: "ada",
          }),
        ),
      ],
      [
        "slack-dismissed-threads",
        new TextEncoder().encode(
          JSON.stringify({ teamUrl: "https://acme.slack.com/", userId: "U1", threads: [] }),
        ),
      ],
      [
        "slack-excluded-channels",
        new TextEncoder().encode(
          JSON.stringify({ teamUrl: "https://acme.slack.com/", userId: "U1", channelIds: [] }),
        ),
      ],
    ]);
    const testLayer = SlackService.layer.pipe(
      Layer.provide(fakeSlack([], new Set())),
      Layer.provide(memorySecrets(secrets)),
      Layer.provide(NodeServices.layer),
      Layer.provide(fakeGitHub),
    );
    return Effect.gen(function* () {
      const slack = yield* SlackService.SlackService;
      yield* waitForState((state) => state.threads.length === 1 && state.conversations.length > 0);
      yield* slack.resetInbox;
      const reset = yield* waitForState((state) => state.threads.length === 0);
      assert.strictEqual(reset.connection.status, "connected");
      assert.deepStrictEqual(reset.conversations, []);
      assert.deepStrictEqual(reset.dismissed, []);
      assert.deepStrictEqual(reset.excludedChannelIds, []);
      assert.isTrue(secrets.has("slack-inbox-start"));
      assert.isTrue(secrets.has("slack-connection"));
      assert.isFalse(secrets.has("slack-dismissed-threads"));
      assert.isFalse(secrets.has("slack-excluded-channels"));
    }).pipe(
      Effect.provide(testLayer),
      Effect.andThen(
        Effect.gen(function* () {
          const slack = yield* SlackService.SlackService;
          const state = yield* slack.state.pipe(Stream.runHead);
          assert.deepStrictEqual(Option.getOrThrow(state).threads, []);
          assert.deepStrictEqual(Option.getOrThrow(state).conversations, []);
        }).pipe(Effect.provide(testLayer)),
      ),
    );
  });

  it.live("persists dismissed threads and channel exclusions across service restarts", () => {
    const calls: Array<SlackCall> = [];
    const rateLimited = new Set<string>();
    const secrets = new Map<string, Uint8Array>([
      [
        "slack-connection",
        new TextEncoder().encode(
          JSON.stringify({
            clientId: "123.456",
            accessToken: "xoxp-test",
            teamName: "Acme",
            teamUrl: "https://acme.slack.com/",
            userId: "U1",
            userName: "ada",
          }),
        ),
      ],
    ]);
    const layer = SlackService.layer.pipe(
      Layer.provide(fakeSlack(calls, rateLimited)),
      Layer.provide(memorySecrets(secrets)),
      Layer.provide(NodeServices.layer),
      Layer.provide(fakeGitHub),
    );
    return Effect.gen(function* () {
      const thread = yield* Effect.gen(function* () {
        const slack = yield* SlackService.SlackService;
        const synced = yield* waitForState((state) => state.threads.length === 1);
        const thread = synced.threads[0]!;
        yield* slack.setDismissed({ channelId: thread.channelId, ts: thread.ts, dismissed: true });
        const dismissed = yield* waitForState((state) => state.dismissed.length === 1);
        assert.deepStrictEqual(
          dismissed.dismissed.map(({ channelId, ts }) => ({ channelId, ts })),
          [{ channelId: thread.channelId, ts: thread.ts }],
        );
        assert.isNumber(dismissed.dismissed[0]?.at);
        assert.deepStrictEqual(yield* slack.getChannels, [
          { id: "C1", name: "general", kind: "channel" },
        ]);
        yield* slack.setChannelExcluded({ channelId: "C1", excluded: true });
        const excluded = yield* waitForState((state) => state.excludedChannelIds.length === 1);
        assert.deepStrictEqual(excluded.excludedChannelIds, ["C1"]);
        assert.strictEqual(excluded.sync.channelCount, 0);
        assert.strictEqual(excluded.sync.availableChannelCount, 1);
        assert.deepStrictEqual(excluded.threads, []);
        const stillFollowed = yield* waitForState(
          (state) =>
            state.excludedChannelIds.length === 1 &&
            state.conversations.filter((item) => item.followed).length === 2,
        );
        assert.isTrue(stillFollowed.conversations.some((item) => item.channelId === "C1"));
        return thread;
      }).pipe(Effect.provide(layer));

      yield* Effect.gen(function* () {
        const slack = yield* SlackService.SlackService;
        const restored = yield* waitForState((state) => state.dismissed.length === 1);
        assert.deepStrictEqual(
          restored.dismissed.map(({ channelId, ts }) => ({ channelId, ts })),
          [{ channelId: thread.channelId, ts: thread.ts }],
        );
        const excluded = yield* waitForState(
          (state) =>
            state.excludedChannelIds.length === 1 && state.sync.availableChannelCount === 1,
        );
        assert.deepStrictEqual(excluded.threads, []);
        assert.strictEqual(excluded.sync.channelCount, 0);
        yield* slack.setChannelExcluded({ channelId: "C1", excluded: false });
        const included = yield* waitForState(
          (state) => state.excludedChannelIds.length === 0 && state.threads.length === 1,
        );
        assert.strictEqual(included.sync.channelCount, 1);
        yield* slack.setDismissed({ channelId: thread.channelId, ts: thread.ts, dismissed: false });
        const visible = yield* waitForState((state) => state.dismissed.length === 0);
        assert.deepStrictEqual(visible.dismissed, []);
      }).pipe(Effect.provide(layer));
    });
  });

  it.live("signs in with PKCE, follows new threads, and reacts", () => {
    const calls: Array<SlackCall> = [];
    const rateLimited = new Set<string>();
    const secrets = new Map<string, Uint8Array>();
    return Effect.gen(function* () {
      const slack = yield* SlackService.SlackService;
      const authorizing = yield* slack.connect({ clientId: "123.456" });
      assert.strictEqual(authorizing.status, "authorizing");
      if (authorizing.status !== "authorizing") return;
      const authorizeUrl = new URL(authorizing.authorizeUrl);
      assert.strictEqual(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
      assert.strictEqual(authorizeUrl.searchParams.get("redirect_uri"), SLACK_OAUTH_REDIRECT_URI);
      assert.include(authorizeUrl.searchParams.get("user_scope") ?? "", "reactions:write");

      // A redirect for another sign-in attempt is refused.
      const forged = yield* Effect.flip(
        slack.completeConnect({ callbackUrl: `${SLACK_OAUTH_REDIRECT_URI}?code=x&state=nope` }),
      );
      assert.strictEqual(forged._tag, "SlackError");

      const state = authorizeUrl.searchParams.get("state");
      const connected = yield* slack.completeConnect({
        callbackUrl: `${SLACK_OAUTH_REDIRECT_URI}?code=abc&state=${state}`,
      });
      assert.deepStrictEqual(connected, {
        status: "connected",
        clientId: "123.456",
        teamName: "Acme",
        teamUrl: "https://acme.slack.com/",
        userId: "U1",
        userName: "ada",
      });
      const exchange = calls.find((call) => call.method === "oauth.v2.access");
      assert.isTrue((exchange?.params.get("code_verifier")?.length ?? 0) > 40);
      assert.isNull(exchange?.params.get("client_secret") ?? null);

      const synced = yield* waitForState((value) => value.sync.syncedChannelCount === 1);
      assert.strictEqual(synced.threads.length, 1);
      // PRs linked from a thread carry their GitHub state.
      const merged = yield* waitForState(
        (value) => value.threads[0]?.pullRequests?.[0]?.state === "merged",
      );
      assert.deepStrictEqual(merged.threads[0]?.pullRequests, [
        {
          url: "https://github.com/acme/app/pull/7",
          repository: "acme/app",
          number: 7,
          state: "merged",
        },
      ]);
      const [thread] = synced.threads;
      assert.strictEqual(thread?.channelName, "general");
      assert.strictEqual(thread?.authorName, "Bo");
      assert.strictEqual(
        thread?.markdown,
        "**ship** it **@Ada** :blob: [acme/app#7](https://github.com/acme/app/pull/7)",
      );
      assert.strictEqual(thread?.replyCount, 1);
      assert.deepStrictEqual(thread?.reactions, [
        { name: "blob", count: 1, reacted: false, imageUrl: "https://emoji.test/p.gif" },
      ]);
      assert.strictEqual(
        thread?.permalink,
        `https://acme.slack.com/archives/C1/p${thread?.ts.replace(".", "")}`,
      );
      assert.isTrue(
        calls
          .filter((call) => call.method === "conversations.history")
          .every((call) => call.token === "xoxp-test"),
      );

      const detail = yield* slack.getThread({ url: thread!.permalink });
      assert.strictEqual(detail.thread.ts, thread!.ts);
      assert.strictEqual(detail.thread.channelName, "general");
      assert.strictEqual(detail.replies.length, 1);
      assert.strictEqual(detail.hasMore, false);
      const callCount = calls.length;
      const wrongWorkspace = yield* Effect.flip(
        slack.getThread({ url: thread!.permalink.replace("acme.slack.com", "other.slack.com") }),
      );
      assert.include(wrongWorkspace.message, "different Slack workspace");
      assert.strictEqual(calls.length, callCount);
      const missing = yield* Effect.flip(
        slack.getThread({ url: "https://acme.slack.com/archives/C1/p1000000000000000" }),
      );
      assert.include(missing.message, "not accessible");
      const replies = yield* slack.getReplies({ channelId: "C1", ts: thread!.ts });
      assert.deepStrictEqual(
        replies.map((message) => [message.authorName, message.markdown]),
        [["Ada", "reply"]],
      );

      // Followed threads come from the user's own :eyes: reactions, anywhere in the workspace.
      const followedOnly = (value: SlackState) =>
        value.conversations.filter((item) => item.followed);
      const followed = yield* waitForState((value) => followedOnly(value).length === 2);
      assert.deepStrictEqual(
        followedOnly(followed).map((item) => [
          item.channelId,
          item.ts,
          item.channelName,
          item.channelKind,
        ]),
        [
          ["C1", thread!.ts, "general", "channel"],
          ["D9", "1700000000.000100", "Bo", "dm"],
        ],
      );
      assert.strictEqual(followedOnly(followed)[0]?.replyCount, 1);
      // Your own reply is the newest, so the conversation waits on someone else.
      assert.strictEqual(followedOnly(followed)[0]?.lastReply?.by, "me");

      const members = yield* slack.listMembers;
      assert.deepStrictEqual(members, [
        { userId: "U1", name: "Ada" },
        { userId: "U2", name: "Bo", avatarUrl: "https://a.test/bo.png" },
      ]);
      const memberCalls = calls.filter((call) => call.method === "users.list").length;
      yield* slack.listMembers;
      assert.strictEqual(calls.filter((call) => call.method === "users.list").length, memberCalls);

      // The follow mark is on a reply; unfollow removes that mark and drops its parent.
      yield* slack.unfollow({ channelId: "C1", ts: thread!.ts });
      const unfollowed = yield* waitForState((value) => followedOnly(value).length === 1);
      assert.strictEqual(followedOnly(unfollowed)[0]?.channelId, "D9");
      assert.isTrue(
        calls.some(
          (call) =>
            call.method === "reactions.remove" &&
            call.params.get("timestamp") === thread!.latestReplyTs,
        ),
      );

      // Slack's 429 fails the click, and the next one waits out Retry-After.
      rateLimited.add("reactions.add");
      const limited = yield* Effect.flip(
        slack.setReaction({ channelId: "C1", ts: thread!.ts, name: "blob", reacted: true }),
      );
      assert.include(limited.message, "rate limiting");
      yield* slack.setReaction({ channelId: "C1", ts: thread!.ts, name: "blob", reacted: true });
      const reacted = yield* waitForState(
        (value) => value.threads[0]?.reactions[0]?.reacted === true,
      );
      assert.strictEqual(reacted.threads[0]?.reactions[0]?.count, 2);

      yield* slack.disconnect;
      const disconnected = yield* waitForState(
        (value) => value.connection.status === "disconnected",
      );
      assert.deepStrictEqual(disconnected.threads, []);
      assert.strictEqual(calls.at(-1)?.method, "auth.revoke");
      // The app is remembered past sign-out, and past a restart.
      assert.strictEqual(disconnected.connection.clientId, "123.456");
      assert.isFalse(secrets.has("slack-connection"));
      assert.isTrue(secrets.has("slack-client-id"));
    }).pipe(
      Effect.provide(
        SlackService.layer.pipe(
          Layer.provide(fakeSlack(calls, rateLimited)),
          Layer.provide(memorySecrets(secrets)),
          Layer.provide(NodeServices.layer),
          Layer.provide(fakeGitHub),
          Layer.provide(fakeGitHub),
        ),
      ),
      Effect.andThen(
        Effect.gen(function* () {
          const slack = yield* SlackService.SlackService;
          const state = yield* slack.state.pipe(Stream.runHead);
          assert.strictEqual(Option.getOrThrow(state).connection.clientId, "123.456");
        }).pipe(
          Effect.provide(
            SlackService.layer.pipe(
              Layer.provide(fakeSlack(calls, rateLimited)),
              Layer.provide(memorySecrets(secrets)),
              Layer.provide(NodeServices.layer),
              Layer.provide(fakeGitHub),
              Layer.provide(fakeGitHub),
              Layer.provide(fakeGitHub),
            ),
          ),
        ),
      ),
    );
  });

  it.live("tracks Devin threads you started, with the session state from Devin", () => {
    const calls: Array<SlackCall> = [];
    const secrets = new Map<string, Uint8Array>([
      [
        "slack-connection",
        new TextEncoder().encode(
          JSON.stringify({
            clientId: "123.456",
            accessToken: "xoxp-test",
            teamName: "Acme",
            teamUrl: "https://acme.slack.com/",
            userId: "U1",
            userName: "ada",
          }),
        ),
      ],
    ]);
    return Effect.gen(function* () {
      const slack = yield* SlackService.SlackService;
      const found = yield* waitForState((state) =>
        state.conversations.some((item) => item.channelId === "C2"),
      );
      const conversation = found.conversations.find((item) => item.channelId === "C2")!;
      assert.strictEqual(conversation.channelName, "bugs");
      assert.isTrue(conversation.startedByMe);
      assert.isFalse(conversation.followed);
      assert.strictEqual(conversation.lastReply?.by, "devin");
      assert.deepStrictEqual(
        conversation.devin?.sessions.map((session) => session.id),
        ["0123456789abcdef0123456789abcdef"],
      );
      // Devin's reply links the PR, so it counts even though the root does not.
      assert.deepStrictEqual(
        conversation.pullRequests?.map((request) => request.number),
        [8],
      );
      // Someone else's Devin thread you never wrote in is not yours.
      assert.isFalse(found.conversations.some((item) => item.channelId === "C3"));
      assert.strictEqual(found.devin.status, "disconnected");

      const devin = yield* slack.devinConnect({ apiKey: "cog_test_key" });
      assert.deepStrictEqual(devin, { status: "connected", name: "ada", orgId: "org-1" });
      assert.isTrue(secrets.has("devin-api"));
      const waiting = yield* waitForState((state) =>
        state.conversations.some((item) => item.devin?.sessions[0]?.state === "waiting"),
      );
      const tracked = waiting.conversations.find((item) => item.channelId === "C2")!;
      assert.strictEqual(tracked.devin?.sessions[0]?.title, "Fix the login bug");
      // PRs Devin reports join the ones linked in Slack.
      assert.deepStrictEqual(
        tracked.pullRequests?.map((request) => request.number),
        [8, 9],
      );
      assert.isTrue(
        calls
          .filter((call) => call.method.startsWith("devin:"))
          .every((call) => call.token === "cog_test_key"),
      );

      yield* slack.devinDisconnect;
      const removed = yield* waitForState((state) => state.devin.status === "disconnected");
      assert.isUndefined(
        removed.conversations.find((item) => item.channelId === "C2")?.devin?.sessions[0]?.state,
      );
      assert.isFalse(secrets.has("devin-api"));
    }).pipe(
      Effect.provide(
        SlackService.layer.pipe(
          Layer.provide(fakeSlack(calls, new Set())),
          Layer.provide(memorySecrets(secrets)),
          Layer.provide(NodeServices.layer),
          Layer.provide(fakeGitHub),
        ),
      ),
    );
  });

  it.live("asks to sign in again when search is not granted", () => {
    const secrets = new Map<string, Uint8Array>([
      [
        "slack-connection",
        new TextEncoder().encode(
          JSON.stringify({
            clientId: "123.456",
            accessToken: "xoxp-test",
            teamName: "Acme",
            teamUrl: "https://acme.slack.com/",
            userId: "U1",
            userName: "ada",
          }),
        ),
      ],
    ]);
    return Effect.gen(function* () {
      const state = yield* waitForState(
        (value) =>
          value.connection.status === "connected" &&
          (value.connection.missingScopes?.length ?? 0) > 0,
      );
      assert.deepStrictEqual(
        state.connection.status === "connected" ? state.connection.missingScopes : [],
        ["search:read"],
      );
    }).pipe(
      Effect.provide(
        SlackService.layer.pipe(
          Layer.provide(fakeSlack([], new Set(), { searchError: "missing_scope" })),
          Layer.provide(memorySecrets(secrets)),
          Layer.provide(NodeServices.layer),
          Layer.provide(fakeGitHub),
        ),
      ),
    );
  });

  it.live("shows what an earlier run read before Slack answers", () => {
    const secrets = new Map<string, Uint8Array>([
      [
        "slack-connection",
        new TextEncoder().encode(
          JSON.stringify({
            clientId: "123.456",
            accessToken: "xoxp-test",
            teamName: "Acme",
            teamUrl: "https://acme.slack.com/",
            userId: "U1",
            userName: "ada",
          }),
        ),
      ],
    ]);
    const layer = (http: Layer.Layer<HttpClient.HttpClient>) =>
      SlackService.layer.pipe(
        Layer.provide(http),
        Layer.provide(memorySecrets(secrets)),
        Layer.provide(NodeServices.layer),
        Layer.provide(fakeGitHub),
      );
    // Slack never answers, so anything in the first state came from the cache.
    const unreachable = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.never),
    );
    return Effect.gen(function* () {
      yield* waitForState(
        (state) =>
          state.threads.length === 1 &&
          state.conversations.some((item) => item.channelId === "C2") &&
          state.conversations.some((item) => item.channelId === "D9"),
      ).pipe(Effect.provide(layer(fakeSlack([], new Set()))));
      assert.isTrue(secrets.has("slack-cache"));

      const restored = yield* Effect.gen(function* () {
        const slack = yield* SlackService.SlackService;
        return Option.getOrThrow(yield* slack.state.pipe(Stream.runHead));
      }).pipe(Effect.provide(layer(unreachable)));
      assert.strictEqual(restored.connection.status, "connected");
      assert.strictEqual(restored.threads[0]?.authorName, "Bo");
      assert.strictEqual(restored.sync.syncedChannelCount, 1);
      const devin = restored.conversations.find((item) => item.channelId === "C2");
      assert.strictEqual(devin?.lastReply?.by, "devin");
      assert.isTrue(
        restored.conversations.some((item) => item.channelId === "D9" && item.followed),
      );
    });
  });

  it.live("forgets the cache on sign-out and on an inbox reset", () => {
    const secrets = new Map<string, Uint8Array>([
      [
        "slack-connection",
        new TextEncoder().encode(
          JSON.stringify({
            clientId: "123.456",
            accessToken: "xoxp-test",
            teamName: "Acme",
            teamUrl: "https://acme.slack.com/",
            userId: "U1",
            userName: "ada",
          }),
        ),
      ],
    ]);
    return Effect.gen(function* () {
      const slack = yield* SlackService.SlackService;
      yield* waitForState((state) => state.threads.length === 1);
      yield* slack.resetInbox;
      assert.isFalse(secrets.has("slack-cache"));
      yield* slack.disconnect;
      assert.isFalse(secrets.has("slack-cache"));
    }).pipe(
      Effect.provide(
        SlackService.layer.pipe(
          Layer.provide(fakeSlack([], new Set())),
          Layer.provide(memorySecrets(secrets)),
          Layer.provide(NodeServices.layer),
          Layer.provide(fakeGitHub),
        ),
      ),
    );
  });
});
