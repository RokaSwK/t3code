import { describe, expect, it } from "vite-plus/test";

import {
  isSlackThreadRoot,
  slackFeedOrder,
  slackFollowedRefs,
  slackLatestActivityMs,
  slackPermalink,
  slackPollDelayMs,
  slackPullRequestLinks,
  slackPullRequestStateQuery,
  slackPullRequestStates,
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

describe("slackFollowedRefs", () => {
  it("keeps only messages the user marked, follows replies to their root, and dedupes", () => {
    const eyes = (users: string[]) => [{ name: "eyes", count: users.length, users }];
    const refs = slackFollowedRefs(
      [
        { type: "file", channel: "C1", message: { ts: "5.000000", reactions: eyes(["U1"]) } },
        { type: "message", channel: "C1", message: { ts: "4.000000", reactions: eyes(["U2"]) } },
        { type: "message", channel: "C1", message: { ts: "3.000000", reactions: eyes(["U1"]) } },
        {
          type: "message",
          channel: "C1",
          message: { ts: "3.500000", thread_ts: "3.000000", reactions: eyes(["U1"]) },
        },
        {
          type: "message",
          channel: "C2",
          message: { ts: "2.500000", thread_ts: "2.000000", reactions: eyes(["U1"]) },
        },
        {
          type: "message",
          channel: "C1",
          message: { ts: "1.000000", reactions: [{ name: "tada", count: 1, users: ["U1"] }] },
        },
      ],
      "U1",
      "eyes",
    );
    expect(refs.map((ref) => [ref.channelId, ref.ts, ref.root !== undefined])).toEqual([
      ["C1", "3.000000", true],
      ["C2", "2.000000", false],
    ]);
  });
});

describe("slack pull request links", () => {
  it("finds github.com PRs once each, from Slack or markdown links", () => {
    const text =
      "<https://github.com/acme/api/pull/774|acme/api#774> and [again](https://github.com/acme/api/pull/774/files), plus https://github.com/acme/mobile/pull/696 and https://github.com/acme/api/issues/3";
    expect(slackPullRequestLinks(text)).toEqual([
      { url: "https://github.com/acme/api/pull/774", repository: "acme/api", number: 774 },
      { url: "https://github.com/acme/mobile/pull/696", repository: "acme/mobile", number: 696 },
    ]);
  });

  it("reads states by alias and leaves unreadable PRs out", () => {
    const urls = [
      "https://github.com/a/b/pull/1",
      "https://github.com/a/b/pull/2",
      "https://github.com/a/b/pull/3",
    ];
    expect(slackPullRequestStateQuery(urls)).toContain(
      'p2: resource(url: "https://github.com/a/b/pull/3")',
    );
    const states = slackPullRequestStates(urls, {
      data: { p0: { state: "MERGED" }, p1: null, p2: { state: "OPEN" } },
    });
    expect([...states]).toEqual([
      ["https://github.com/a/b/pull/1", "merged"],
      ["https://github.com/a/b/pull/3", "open"],
    ]);
  });
});
