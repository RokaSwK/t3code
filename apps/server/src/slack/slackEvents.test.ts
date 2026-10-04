import { assert, describe, it } from "@effect/vitest";

import { parseSlackSocketFrame, slackEventTarget } from "./slackEvents.ts";

describe("parseSlackSocketFrame", () => {
  it("reads hello, events with their ack, and disconnects", () => {
    assert.deepStrictEqual(parseSlackSocketFrame('{"type":"hello","num_connections":1}'), {
      type: "hello",
    });
    assert.deepStrictEqual(
      parseSlackSocketFrame(
        '{"type":"events_api","envelope_id":"e1","payload":{"event":{"type":"message","channel":"C1","ts":"1.0"}}}',
      ),
      {
        type: "event",
        ack: '{"envelope_id":"e1"}',
        event: { type: "message", channel: "C1", ts: "1.0" },
      },
    );
    assert.deepStrictEqual(
      parseSlackSocketFrame('{"type":"disconnect","reason":"refresh_requested"}'),
      { type: "disconnect", reason: "refresh_requested" },
    );
    assert.strictEqual(parseSlackSocketFrame("not json"), undefined);
    // An event without an envelope id cannot be acknowledged.
    assert.strictEqual(parseSlackSocketFrame('{"type":"events_api","payload":{}}'), undefined);
  });
});

describe("slackEventTarget", () => {
  it("points a reply at its conversation and notices a mention", () => {
    assert.deepStrictEqual(
      slackEventTarget(
        { type: "message", channel: "C1", ts: "2.0", thread_ts: "1.0", user: "U2", text: "<@U1>?" },
        "U1",
      ),
      { kind: "message", channelId: "C1", ts: "1.0", reply: true, userId: "U2", mentionsMe: true },
    );
  });

  it("follows edits and deletions to the message they change", () => {
    assert.deepStrictEqual(
      slackEventTarget(
        {
          type: "message",
          subtype: "message_changed",
          channel: "C1",
          message: { ts: "3.0", thread_ts: "1.0", user: "U2", text: "fixed" },
        },
        "U1",
      ),
      { kind: "message", channelId: "C1", ts: "1.0", reply: true, userId: "U2", mentionsMe: false },
    );
    assert.deepStrictEqual(
      slackEventTarget(
        {
          type: "message",
          subtype: "message_deleted",
          channel: "C1",
          previous_message: { ts: "1.0", user: "U2" },
        },
        "U1",
      ),
      {
        kind: "message",
        channelId: "C1",
        ts: "1.0",
        reply: false,
        userId: "U2",
        mentionsMe: false,
      },
    );
  });

  it("reads reactions on messages and ignores the rest", () => {
    assert.deepStrictEqual(
      slackEventTarget(
        {
          type: "reaction_added",
          user: "U1",
          reaction: "eyes",
          item: { type: "message", channel: "C1", ts: "1.0" },
        },
        "U1",
      ),
      { kind: "reaction", channelId: "C1", ts: "1.0", userId: "U1", reaction: "eyes", added: true },
    );
    assert.strictEqual(
      slackEventTarget(
        { type: "reaction_added", reaction: "eyes", item: { type: "file", channel: "C1" } },
        "U1",
      ),
      undefined,
    );
    assert.strictEqual(slackEventTarget({ type: "channel_created" }, "U1"), undefined);
  });
});
