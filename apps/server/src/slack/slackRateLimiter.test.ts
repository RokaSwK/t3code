import { describe, expect, it } from "vite-plus/test";

import { SlackRateLimiter } from "./slackRateLimiter.ts";

describe("SlackRateLimiter", () => {
  it("lets a burst through, then spaces calls at the tier rate", () => {
    const limiter = new SlackRateLimiter();
    // Tier 3 holds 9 tokens and refills 45 per minute.
    for (let index = 0; index < 9; index += 1) {
      expect(limiter.reserve("conversations.history", "interactive", 0)).toBe(0);
    }
    const wait = limiter.reserve("conversations.history", "interactive", 0);
    expect(wait).toBe(Math.ceil(60_000 / 45));
    expect(limiter.reserve("conversations.history", "interactive", wait)).toBe(0);
  });

  it("keeps tokens back from background polling for user actions", () => {
    const limiter = new SlackRateLimiter();
    let taken = 0;
    while (limiter.reserve("conversations.history", "background", 0) === 0) taken += 1;
    expect(taken).toBe(7);
    expect(limiter.reserve("reactions.add", "interactive", 0)).toBe(0);
    expect(limiter.reserve("reactions.add", "interactive", 0)).toBe(0);
    expect(limiter.reserve("reactions.add", "interactive", 0)).toBeGreaterThan(0);
  });

  it("pauses only the method Slack rate limited", () => {
    const limiter = new SlackRateLimiter();
    limiter.pause("conversations.history", 30_000);
    expect(limiter.reserve("conversations.history", "interactive", 1_000)).toBe(29_000);
    expect(limiter.reserve("conversations.replies", "interactive", 1_000)).toBe(0);
    expect(limiter.pausedUntilMs(1_000)).toBe(30_000);
    expect(limiter.pausedUntilMs(30_000)).toBeUndefined();
  });
});
