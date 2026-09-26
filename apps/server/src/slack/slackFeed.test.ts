import { describe, expect, it } from "vite-plus/test";

import {
  isSlackThreadRoot,
  slackFeedOrder,
  slackLatestActivityMs,
  slackPermalink,
  slackPollDelayMs,
} from "./slackFeed.ts";

describe("isSlackThreadRoot", () => {
  it("keeps conversation starters and drops replies and notices", () => {
    expect(isSlackThreadRoot({ ts: "1.0" })).toBe(true);
    expect(isSlackThreadRoot({ ts: "1.0", thread_ts: "1.0" })).toBe(true);
    expect(isSlackThreadRoot({ ts: "1.0", subtype: "bot_message" })).toBe(true);
    expect(isSlackThreadRoot({ ts: "2.0", thread_ts: "1.0" })).toBe(false);
    expect(isSlackThreadRoot({ ts: "2.0", thread_ts: "1.0", subtype: "thread_broadcast" })).toBe(
      false,
    );
    expect(isSlackThreadRoot({ ts: "1.0", subtype: "channel_join" })).toBe(false);
  });
});

describe("slackPollDelayMs", () => {
  const now = 10 * 24 * 60 * 60_000;
  it("reads busy channels often and quiet ones rarely", () => {
    expect(slackPollDelayMs(now - 5 * 60_000, now)).toBe(30_000);
    expect(slackPollDelayMs(now - 3 * 60 * 60_000, now)).toBe(120_000);
    expect(slackPollDelayMs(now - 2 * 24 * 60 * 60_000, now)).toBe(600_000);
    expect(slackPollDelayMs(undefined, now)).toBe(600_000);
  });
});

describe("slackLatestActivityMs", () => {
  it("counts replies as activity", () => {
    expect(
      slackLatestActivityMs([{ ts: "100.000100", latest_reply: "300.5" }, { ts: "200.0" }]),
    ).toBe(300_500);
    expect(slackLatestActivityMs([])).toBeUndefined();
  });
});

describe("slackPermalink", () => {
  it("builds Slack's archive link", () => {
    expect(slackPermalink("https://acme.slack.com/", "C1", "1700000000.123456")).toBe(
      "https://acme.slack.com/archives/C1/p1700000000123456",
    );
  });
});

describe("slackFeedOrder", () => {
  it("sorts newest first and caps", () => {
    expect(slackFeedOrder([{ ts: "1.5" }, { ts: "10.0" }, { ts: "2.0" }], 2)).toEqual([
      { ts: "10.0" },
      { ts: "2.0" },
    ]);
  });
});
