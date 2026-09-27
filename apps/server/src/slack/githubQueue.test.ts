import { describe, expect, it } from "@effect/vitest";

import { parseGitHubQueue } from "./githubQueue.ts";

describe("parseGitHubQueue", () => {
  it("reads both searches with review, checks, and conflicts", () => {
    const queue = parseGitHubQueue({
      data: {
        reviewRequested: {
          nodes: [
            {
              url: "https://github.com/acme/app/pull/9",
              title: "Fix refunds",
              number: 9,
              isDraft: false,
              updatedAt: "2026-09-27T10:00:00Z",
              reviewDecision: "REVIEW_REQUIRED",
              mergeable: "MERGEABLE",
              repository: { nameWithOwner: "acme/app" },
              author: { login: "rick", avatarUrl: "https://a.test/rick.png" },
              commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] },
            },
            null,
          ],
        },
        authored: {
          nodes: [
            {
              url: "https://github.com/acme/app/pull/8",
              title: "Card feed",
              number: 8,
              isDraft: false,
              updatedAt: "2026-09-27T09:00:00Z",
              reviewDecision: null,
              mergeable: "CONFLICTING",
              repository: { nameWithOwner: "acme/app" },
              author: { login: "ada" },
              commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
            },
          ],
        },
      },
    });
    expect(queue?.reviewRequested).toEqual([
      {
        url: "https://github.com/acme/app/pull/9",
        repository: "acme/app",
        number: 9,
        title: "Fix refunds",
        isDraft: false,
        updatedAt: "2026-09-27T10:00:00Z",
        author: "rick",
        authorAvatarUrl: "https://a.test/rick.png",
        review: "review-required",
        checks: "pending",
      },
    ]);
    expect(queue?.authored[0]).toMatchObject({ checks: "failing", conflicting: true });
    expect(parseGitHubQueue({ errors: [{ message: "nope" }] })).toBeNull();
  });
});
