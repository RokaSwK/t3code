import { assert, describe, it } from "@effect/vitest";

import {
  devinSessionState,
  findDevinUser,
  slackSearchMatchThread,
  summarizeSlackConversation,
} from "./slackConversations.ts";

const devin = { userId: "UDEVIN", botId: "BDEVIN" };
const session = "0123456789abcdef0123456789abcdef";

describe("summarizeSlackConversation", () => {
  it("counts an automation Devin posted on your behalf as started by you", () => {
    const summary = summarizeSlackConversation(
      [
        {
          ts: "1.000001",
          user: "UDEVIN",
          text: "<@U1>: whats up here [Support](<https://x.test>)",
        },
        {
          ts: "2.000001",
          thread_ts: "1.000001",
          bot_id: "BDEVIN",
          text: `Starting [[↗︎]](<https://app.devin.ai/sessions/${session}?ts=1>)`,
        },
      ],
      "U1",
      devin,
    );
    assert.isTrue(summary?.startedByMe);
    assert.isTrue(summary?.mine);
    assert.strictEqual(summary?.lastReply?.by, "devin");
    assert.deepStrictEqual(summary?.devin, {
      sessionIds: [session],
      stopped: false,
      lastMessageTs: "2.000001",
    });
  });

  it("is yours once you write in it, and waits on whoever replied last", () => {
    const summary = summarizeSlackConversation(
      [
        { ts: "1.000001", user: "U2", text: "<@UDEVIN> look" },
        { ts: "2.000001", thread_ts: "1.000001", user: "U1", text: "any news?" },
        { ts: "3.000001", thread_ts: "1.000001", user: "U3", text: "yes, see PR" },
        // Devin's emptied progress message is not a reply anyone wrote.
        { ts: "4.000001", thread_ts: "1.000001", user: "UDEVIN", text: "" },
      ],
      "U1",
      devin,
    );
    assert.isFalse(summary?.startedByMe);
    assert.isTrue(summary?.mine);
    assert.deepStrictEqual(summary?.lastReply, { by: "other", userId: "U3", ts: "3.000001" });
    assert.strictEqual(summary?.latestTs, "4.000001");
  });

  it("notices when Devin's session went to sleep", () => {
    const summary = summarizeSlackConversation(
      [
        { ts: "1.000001", user: "U1", text: "<@UDEVIN> do it" },
        {
          ts: "2.000001",
          thread_ts: "1.000001",
          user: "UDEVIN",
          text: `Done: <https://github.com/acme/app/pull/3> [[↗︎]](<https://app.devin.ai/sessions/${session}>)`,
        },
        {
          ts: "3.000001",
          thread_ts: "1.000001",
          user: "UDEVIN",
          text: "_Tag @Devin here to continue in Slack_",
        },
      ],
      "U1",
      devin,
    );
    assert.isTrue(summary?.devin?.stopped);
    assert.include(summary?.pullRequestText ?? "", "pull/3");
  });
});

describe("Devin in Slack", () => {
  it("finds Devin by its Slack app, then by name", () => {
    assert.deepStrictEqual(
      findDevinUser([
        { id: "U1", name: "devin" },
        { id: "U9", is_bot: true, profile: { bot_id: "B9", api_app_id: "A06A3TU8H39" } },
      ]),
      { userId: "U9", botId: "B9" },
    );
    assert.deepStrictEqual(findDevinUser([{ id: "U8", is_bot: true, real_name: "Devin" }]), {
      userId: "U8",
    });
    assert.isUndefined(findDevinUser([{ id: "U1", name: "devin" }]));
  });

  it("places a search match in its conversation", () => {
    assert.deepStrictEqual(
      slackSearchMatchThread({
        ts: "5.000001",
        channel: { id: "C1" },
        permalink: "https://acme.slack.com/archives/C1/p5000001?thread_ts=1.000001&cid=C1",
      }),
      { channelId: "C1", ts: "1.000001", messageTs: "5.000001" },
    );
    assert.deepStrictEqual(slackSearchMatchThread({ ts: "5.000001", channel: { id: "C1" } }), {
      channelId: "C1",
      ts: "5.000001",
      messageTs: "5.000001",
    });
  });

  it("reduces Devin's session status to what needs you", () => {
    assert.strictEqual(devinSessionState("running", "working"), "working");
    assert.strictEqual(devinSessionState("running", "waiting_for_user"), "waiting");
    assert.strictEqual(devinSessionState("running", "waiting_for_approval"), "waiting");
    assert.strictEqual(devinSessionState("running", "finished"), "finished");
    assert.strictEqual(devinSessionState("suspended", "inactivity"), "suspended");
    assert.strictEqual(devinSessionState("suspended", "out_of_credits"), "error");
    assert.isUndefined(devinSessionState("mystery", null));
  });
});
