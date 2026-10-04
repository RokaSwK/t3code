/**
 * The user's pull request queue on GitHub: open pull requests waiting for their review, and
 * their own open pull requests, with what each is waiting on. Read with one GraphQL search
 * through the `gh` CLI, so it covers every repository the signed-in account can see.
 */
import type { WorkGitHubPullRequest } from "@t3tools/contracts";
import { workSourceLines } from "@t3tools/shared/workRecap";

/** The queue is read this often; it combines the active queue and recent merges in one request. */
export const GITHUB_QUEUE_INTERVAL_MS = 5 * 60_000;
const QUEUE_SIZE = 50;

/**
 * Your own pull requests also read per-file line counts (the first 100 files), which the
 * server reduces to `sourceLines` for the recap's size; the file list never leaves the server.
 */
const pullRequestFields = (files: boolean) => `... on PullRequest {
  url title number isDraft updatedAt mergedAt reviewDecision mergeable
  repository { nameWithOwner }
  author { login avatarUrl }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }${files ? "\n  files(first: 100) { nodes { path additions deletions } }" : ""}
}`;

export const githubQueueQuery = (since: string) => `query {
  reviewRequested: search(query: "is:pr is:open archived:false review-requested:@me", type: ISSUE, first: ${QUEUE_SIZE}) { nodes { ${pullRequestFields(false)} } }
  authored: search(query: "is:pr is:open archived:false author:@me", type: ISSUE, first: ${QUEUE_SIZE}) { nodes { ${pullRequestFields(true)} } }
  merged: search(query: "is:pr is:merged archived:false author:@me merged:>=${since} sort:updated-desc", type: ISSUE, first: 100) { nodes { ${pullRequestFields(true)} } }
}`;

interface RawPullRequest {
  readonly url?: unknown;
  readonly title?: unknown;
  readonly number?: unknown;
  readonly isDraft?: unknown;
  readonly updatedAt?: unknown;
  readonly mergedAt?: unknown;
  readonly reviewDecision?: unknown;
  readonly mergeable?: unknown;
  readonly repository?: { readonly nameWithOwner?: unknown } | null;
  readonly author?: { readonly login?: unknown; readonly avatarUrl?: unknown } | null;
  readonly commits?: {
    readonly nodes?: ReadonlyArray<{
      readonly commit?: { readonly statusCheckRollup?: { readonly state?: unknown } | null };
    } | null>;
  } | null;
  readonly files?: {
    readonly nodes?: ReadonlyArray<{
      readonly path?: unknown;
      readonly additions?: unknown;
      readonly deletions?: unknown;
    } | null>;
  } | null;
}

function pullRequestOf(raw: RawPullRequest | null | undefined): WorkGitHubPullRequest | null {
  if (!raw || typeof raw.url !== "string" || typeof raw.number !== "number") return null;
  const repository = raw.repository?.nameWithOwner;
  if (typeof repository !== "string") return null;
  const checks = raw.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  const review = raw.reviewDecision;
  const author = raw.author;
  const files = raw.files?.nodes?.flatMap((file) =>
    file &&
    typeof file.path === "string" &&
    typeof file.additions === "number" &&
    typeof file.deletions === "number"
      ? [{ path: file.path, additions: file.additions, deletions: file.deletions }]
      : [],
  );
  return {
    url: raw.url,
    repository,
    number: raw.number,
    title: typeof raw.title === "string" ? raw.title : `#${raw.number}`,
    isDraft: raw.isDraft === true,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    ...(typeof raw.mergedAt === "string" ? { mergedAt: raw.mergedAt } : {}),
    ...(typeof author?.login === "string" ? { author: author.login } : {}),
    ...(typeof author?.avatarUrl === "string" ? { authorAvatarUrl: author.avatarUrl } : {}),
    ...(review === "APPROVED"
      ? { review: "approved" as const }
      : review === "CHANGES_REQUESTED"
        ? { review: "changes-requested" as const }
        : review === "REVIEW_REQUIRED"
          ? { review: "review-required" as const }
          : {}),
    ...(checks === "SUCCESS"
      ? { checks: "passing" as const }
      : checks === "FAILURE" || checks === "ERROR"
        ? { checks: "failing" as const }
        : checks === "PENDING" || checks === "EXPECTED"
          ? { checks: "pending" as const }
          : {}),
    ...(raw.mergeable === "CONFLICTING" ? { conflicting: true } : {}),
    ...(files ? { sourceLines: workSourceLines(files) } : {}),
  };
}

/** The searches' pull requests, or null when GitHub did not answer the query. */
export function parseGitHubQueue(response: unknown): {
  readonly reviewRequested: ReadonlyArray<WorkGitHubPullRequest>;
  readonly authored: ReadonlyArray<WorkGitHubPullRequest>;
  readonly merged: ReadonlyArray<WorkGitHubPullRequest>;
} | null {
  const data = (
    response as {
      data?: {
        reviewRequested?: { nodes?: ReadonlyArray<RawPullRequest | null> };
        authored?: { nodes?: ReadonlyArray<RawPullRequest | null> };
        merged?: { nodes?: ReadonlyArray<RawPullRequest | null> };
      };
    } | null
  )?.data;
  if (!data?.reviewRequested || !data.authored) return null;
  const list = (nodes: ReadonlyArray<RawPullRequest | null> | undefined) =>
    (nodes ?? []).flatMap((node) => {
      const pullRequest = pullRequestOf(node);
      return pullRequest ? [pullRequest] : [];
    });
  return {
    reviewRequested: list(data.reviewRequested.nodes),
    authored: list(data.authored.nodes),
    merged: list(data.merged?.nodes).filter((request) => request.mergedAt !== undefined),
  };
}
