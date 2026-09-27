/**
 * Client-side budget for Slack Web API calls.
 *
 * Slack limits each method per workspace per app by tier. We keep a token
 * bucket per tier just under Slack's floor so we rarely see a 429, keep a few
 * tokens that only user-initiated calls may spend so a click never waits
 * behind background polling, and pause a method entirely for as long as a 429
 * says to.
 */

export type SlackCallPriority = "interactive" | "background";

type SlackTier = 2 | 3 | 4;

const METHOD_TIERS: Record<string, SlackTier> = {
  "users.conversations": 2,
  "emoji.list": 2,
  "users.list": 2,
  "reactions.list": 2,
  "search.messages": 2,
  "conversations.history": 3,
  "conversations.replies": 3,
  "reactions.add": 3,
  "reactions.remove": 3,
  "users.info": 4,
  "auth.test": 4,
};

/** Slack documents tier 2 as 20+/min, tier 3 as 50+/min, and tier 4 as 100+/min. */
const TIER_PER_MINUTE: Record<SlackTier, number> = { 2: 18, 3: 45, 4: 90 };
/** Tokens background polling leaves in each bucket for user actions. */
const INTERACTIVE_RESERVE = 2;

interface Bucket {
  tokens: number;
  readonly capacity: number;
  /** Tokens per millisecond. */
  readonly rate: number;
  updatedAt: number;
}

export class SlackRateLimiter {
  private readonly buckets = new Map<SlackTier, Bucket>();
  private readonly pausedUntil = new Map<string, number>();

  /**
   * Takes a token for `method` and returns 0, or returns how many
   * milliseconds to wait before asking again.
   */
  reserve(method: string, priority: SlackCallPriority, now: number): number {
    const paused = this.pausedUntil.get(method) ?? 0;
    if (paused > now) return paused - now;
    const bucket = this.bucket(METHOD_TIERS[method] ?? 3, now);
    const needed = 1 + (priority === "background" ? INTERACTIVE_RESERVE : 0);
    if (bucket.tokens >= needed) {
      bucket.tokens -= 1;
      return 0;
    }
    return Math.ceil((needed - bucket.tokens) / bucket.rate);
  }

  /** Honors a 429's Retry-After for one method. */
  pause(method: string, untilMs: number): void {
    this.pausedUntil.set(method, Math.max(untilMs, this.pausedUntil.get(method) ?? 0));
  }

  /** The latest pause still in force, for showing that sync is waiting on Slack. */
  pausedUntilMs(now: number): number | undefined {
    let latest: number | undefined;
    for (const until of this.pausedUntil.values()) {
      if (until > now && (latest === undefined || until > latest)) latest = until;
    }
    return latest;
  }

  private bucket(tier: SlackTier, now: number): Bucket {
    let bucket = this.buckets.get(tier);
    if (!bucket) {
      const perMinute = TIER_PER_MINUTE[tier];
      const capacity = Math.max(4, Math.floor(perMinute / 5));
      bucket = { tokens: capacity, capacity, rate: perMinute / 60_000, updatedAt: now };
      this.buckets.set(tier, bucket);
    }
    bucket.tokens = Math.min(
      bucket.capacity,
      bucket.tokens + Math.max(0, now - bucket.updatedAt) * bucket.rate,
    );
    bucket.updatedAt = now;
    return bucket;
  }
}
