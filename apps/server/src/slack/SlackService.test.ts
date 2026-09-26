import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { SLACK_OAUTH_REDIRECT_URI, type SlackState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SlackService from "./SlackService.ts";

interface SlackCall {
  readonly method: string;
  readonly params: URLSearchParams;
  readonly token: string | undefined;
}

// @effect-diagnostics-next-line globalDate:off - the service reads Slack's recent window live.
const nowTs = (offsetSeconds: number) => (Date.now() / 1000 + offsetSeconds).toFixed(6);

/** A small Slack workspace: one channel with a thread, a reply, and a join notice. */
function fakeSlack(calls: Array<SlackCall>, rateLimited: Set<string>) {
  const root = nowTs(-600);
  const reply = nowTs(-300);
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
          text: "*ship* it <@U1> :blob:",
          reply_count: 1,
          latest_reply: reply,
          reactions: [{ name: "blob", count: 1, users: ["U2"] }],
        },
      ],
    },
    "conversations.replies": {
      ok: true,
      messages: [
        { ts: root, user: "U2", text: "root" },
        { ts: reply, thread_ts: root, user: "U1", text: "reply" },
      ],
    },
    "users.info": { ok: true },
    "reactions.add": { ok: true },
  };
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
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
        const body =
          method === "users.info"
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

function memorySecrets() {
  const store = new Map<string, Uint8Array>();
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
  it.live("signs in with PKCE, follows new threads, and reacts", () => {
    const calls: Array<SlackCall> = [];
    const rateLimited = new Set<string>();
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
        userName: "ada",
      });
      const exchange = calls.find((call) => call.method === "oauth.v2.access");
      assert.isTrue((exchange?.params.get("code_verifier")?.length ?? 0) > 40);
      assert.isNull(exchange?.params.get("client_secret") ?? null);

      const synced = yield* waitForState((value) => value.sync.syncedChannelCount === 1);
      assert.strictEqual(synced.threads.length, 1);
      const [thread] = synced.threads;
      assert.strictEqual(thread?.channelName, "general");
      assert.strictEqual(thread?.authorName, "Bo");
      assert.strictEqual(thread?.markdown, "**ship** it **@Ada** :blob:");
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

      const replies = yield* slack.getReplies({ channelId: "C1", ts: thread!.ts });
      assert.deepStrictEqual(
        replies.map((message) => [message.authorName, message.markdown]),
        [["Ada", "reply"]],
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
    }).pipe(
      Effect.provide(
        SlackService.layer.pipe(
          Layer.provide(fakeSlack(calls, rateLimited)),
          Layer.provide(memorySecrets()),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  });
});
