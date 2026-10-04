import { assert, describe, it } from "@effect/vitest";

import { slackMentionHit, type SlackMentionHit, unansweredSlackMentions } from "./slackMentions.ts";

const hit = (messageTs: string, overrides: Partial<SlackMentionHit> = {}): SlackMentionHit => ({
  channelId: "C1",
  ts: messageTs,
  messageTs,
  userId: "U2",
  direct: false,
  text: "<@U1> can you look?",
  permalink: `https://x.slack.com/archives/C1/p${messageTs.replace(".", "")}`,
  ...overrides,
});

const unanswered = (
  mentions: ReadonlyArray<SlackMentionHit>,
  mine: ReadonlyArray<SlackMentionHit> = [],
  reacted: ReadonlyArray<string> = [],
  mineSince?: string,
) =>
  unansweredSlackMentions({ mentions, mine, reacted: new Set(reacted), me: "U1", mineSince }).map(
    (mention) => mention.messageTs,
  );

describe("unansweredSlackMentions", () => {
  it("drops a mention you replied after in the same conversation", () => {
    const mention = hit("2.000001", { ts: "1.000001" });
    assert.deepStrictEqual(
      unanswered([mention], [hit("3.000001", { ts: "1.000001", userId: "U1" })]),
      [],
    );
    // A reply before the mention, or in another conversation, does not answer it.
    assert.deepStrictEqual(
      unanswered(
        [mention],
        [
          hit("1.500001", { ts: "1.000001", userId: "U1" }),
          hit("4.000001", { ts: "4.000001", userId: "U1" }),
        ],
      ),
      ["2.000001"],
    );
  });

  it("counts a reaction on the mention as an answer", () => {
    assert.deepStrictEqual(unanswered([hit("2.000001")], [], ["C1:2.000001"]), []);
  });

  it("answers a direct message anywhere later in it, but not a channel", () => {
    const direct = hit("2.000001", { channelId: "D1", direct: true });
    const later = hit("3.000001", { channelId: "D1", direct: true, userId: "U1" });
    assert.deepStrictEqual(unanswered([direct], [later]), []);
    const channel = hit("2.000001");
    assert.deepStrictEqual(
      unanswered([channel], [hit("3.000001", { userId: "U1", ts: "3.000001" })]),
      ["2.000001"],
    );
  });

  it("keeps the newest mention per conversation and skips your own and apps'", () => {
    const { userId: _, ...byApp } = hit("5.000001");
    assert.deepStrictEqual(
      unanswered([
        hit("2.000001", { ts: "1.000001" }),
        hit("3.000001", { ts: "1.000001" }),
        hit("4.000001", { userId: "U1" }),
        byApp,
      ]),
      ["3.000001"],
    );
  });

  it("leaves out mentions older than the messages of yours it read", () => {
    assert.deepStrictEqual(unanswered([hit("2.000001"), hit("9.000001")], [], [], "5.000001"), [
      "9.000001",
    ]);
  });
});

describe("slackMentionHit", () => {
  it("reads the conversation from the permalink and marks direct messages", () => {
    assert.deepStrictEqual(
      slackMentionHit({
        ts: "2.000001",
        user: "U2",
        text: "hey <@U1>",
        permalink: "https://x.slack.com/archives/D1/p2000001?thread_ts=1.000001",
        channel: { id: "D1", is_im: true },
      }),
      {
        channelId: "D1",
        ts: "1.000001",
        messageTs: "2.000001",
        userId: "U2",
        direct: true,
        text: "hey <@U1>",
        permalink: "https://x.slack.com/archives/D1/p2000001?thread_ts=1.000001",
      },
    );
  });
});
