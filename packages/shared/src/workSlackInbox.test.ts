import type { SlackThread } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { slackThreadDoneReason } from "./work.ts";

const thread = (overrides: Partial<SlackThread>): SlackThread => ({
  channelId: "C1",
  ts: "1.0",
  authorName: "Ada",
  markdown: "",
  fileCount: 0,
  edited: false,
  replyCount: 0,
  reactions: [],
  channelName: "dev",
  channelKind: "channel",
  permalink: "https://acme.slack.com/archives/C1/p10",
  ...overrides,
});

const pr = (number: number, state?: "open" | "closed" | "merged") => ({
  url: `https://github.com/acme/api/pull/${number}`,
  repository: "acme/api",
  number,
  ...(state ? { state } : {}),
});

describe("slackThreadDoneReason", () => {
  it("treats a tick from anyone as done, and other reactions as not", () => {
    const tick = { name: "white_check_mark", count: 1, reacted: false };
    const eyes = { name: "eyes", count: 2, reacted: true };
    expect(slackThreadDoneReason(thread({ reactions: [eyes, tick] }))).toBe("Marked ✅ in Slack");
    expect(slackThreadDoneReason(thread({ reactions: [eyes] }))).toBeNull();
  });

  it("is done only once every linked PR has landed or closed", () => {
    expect(slackThreadDoneReason(thread({ pullRequests: [pr(1, "merged")] }))).toBe("PR merged");
    expect(
      slackThreadDoneReason(thread({ pullRequests: [pr(1, "merged"), pr(2, "closed")] })),
    ).toBe("PRs merged or closed");
    expect(
      slackThreadDoneReason(thread({ pullRequests: [pr(1, "merged"), pr(2, "open")] })),
    ).toBeNull();
    // Unknown state never hides a thread.
    expect(slackThreadDoneReason(thread({ pullRequests: [pr(1)] }))).toBeNull();
  });
});
