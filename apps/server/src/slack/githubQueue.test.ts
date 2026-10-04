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

it("retains the merge date independently of a later update", () => {
  const queue = parseGitHubQueue({
    data: {
      reviewRequested: { nodes: [] },
      authored: { nodes: [] },
      merged: {
        nodes: [
          {
            url: "https://github.com/acme/app/pull/9",
            number: 9,
            repository: { nameWithOwner: "acme/app" },
            mergedAt: "2026-09-26T10:00:00Z",
            updatedAt: "2026-09-28T10:00:00Z",
          },
        ],
      },
    },
  });
  expect(queue?.merged).toMatchObject([
    { mergedAt: "2026-09-26T10:00:00Z", updatedAt: "2026-09-28T10:00:00Z" },
  ]);
});

it("reduces a pull request's files to its source lines", () => {
  const queue = parseGitHubQueue({
    data: {
      reviewRequested: { nodes: [] },
      authored: { nodes: [] },
      merged: {
        nodes: [
          {
            url: "https://github.com/acme/app/pull/9",
            number: 9,
            repository: { nameWithOwner: "acme/app" },
            mergedAt: "2026-09-26T10:00:00Z",
            files: {
              nodes: [
                { path: "src/refunds.ts", additions: 40, deletions: 10 },
                { path: "src/refunds.test.ts", additions: 200, deletions: 0 },
                { path: "pnpm-lock.yaml", additions: 900, deletions: 300 },
              ],
            },
          },
        ],
      },
    },
  });
  expect(queue?.merged[0]).toMatchObject({ sourceLines: 50 });
  expect(queue?.merged[0]).not.toHaveProperty("files");
});
