/**
 * Whether the user's recently merged pull requests are deployed, read from their base branches
 * with one GraphQL query through the `gh` CLI. No per-repository setup: a commit counts as
 * deployed when a GitHub Actions workflow named like a deploy (deploy, publish, release, OTA)
 * succeeded on it, or a deployment to a production environment did. A merge is deployed once any
 * commit at or after its merge commit on the base branch is.
 */
import type { WorkDeployment, WorkGitHubPullRequest } from "@t3tools/contracts";

import type { MergeCommit } from "./githubQueue.ts";

/** Merges older than this are not checked again; their last known state stays. */
export const DEPLOYMENT_WINDOW_MS = 3 * 86_400_000;
/** Bounds the query: base branches per request, and the newest commits read on each. */
const MAX_BRANCHES = 10;
const BRANCH_COMMITS = 20;

const DEPLOY_WORKFLOW = /deploy|publish|release|\bota\b/i;
/** Scheduled and pull request runs never ship the base branch, whatever they are called. */
const IGNORED_EVENTS = new Set(["schedule", "pull_request", "pull_request_target", "merge_group"]);
const PRODUCTION_ENVIRONMENT = /prod|live/i;

/** A base branch to read: `owner/name` and the branch. */
export interface DeployBranch {
  readonly repository: string;
  readonly base: string;
}

/** What a commit on the base branch shows: one entry per deploy run or production deployment. */
export interface BranchCommit {
  readonly oid: string;
  readonly committedDate: string;
  readonly signals: ReadonlyArray<WorkDeployment | "skipped">;
}

const branchKey = (branch: DeployBranch) => `${branch.repository.toLowerCase()}#${branch.base}`;

/** Recent merges still worth checking, and the base branches they need, bounded. */
export function deploymentsToCheck(
  merged: ReadonlyArray<WorkGitHubPullRequest>,
  mergeCommits: ReadonlyMap<string, MergeCommit>,
  now: number,
): { readonly requests: ReadonlyArray<WorkGitHubPullRequest>; readonly branches: DeployBranch[] } {
  const branches = new Map<string, DeployBranch>();
  const requests = merged.filter((request) => {
    const merge = mergeCommits.get(request.url);
    if (!merge || request.deployment === "deployed") return false;
    if (now - Date.parse(request.mergedAt ?? "") > DEPLOYMENT_WINDOW_MS) return false;
    const branch = { repository: request.repository, base: merge.base };
    if (!branches.has(branchKey(branch))) {
      if (branches.size >= MAX_BRANCHES) return false;
      branches.set(branchKey(branch), branch);
    }
    return true;
  });
  return { requests, branches: [...branches.values()] };
}

const quote = (value: string) => JSON.stringify(value);

export const githubDeploymentsQuery = (branches: ReadonlyArray<DeployBranch>) => `query {
${branches
  .map((branch, index) => {
    const [owner = "", name = ""] = branch.repository.split("/");
    return `  b${index}: repository(owner: ${quote(owner)}, name: ${quote(name)}) {
    ref(qualifiedName: ${quote(`refs/heads/${branch.base}`)}) { target { ... on Commit {
      history(first: ${BRANCH_COMMITS}) { nodes {
        oid committedDate
        deployments(first: 5) { nodes { environment latestStatus { state } } }
        checkSuites(first: 15) { nodes { status conclusion workflowRun { event workflow { name } } } }
      } }
    } } }
  }`;
  })
  .join("\n")}
}`;

interface RawCommit {
  readonly oid?: unknown;
  readonly committedDate?: unknown;
  readonly deployments?: {
    readonly nodes?: ReadonlyArray<{
      readonly environment?: unknown;
      readonly latestStatus?: { readonly state?: unknown } | null;
    } | null>;
  } | null;
  readonly checkSuites?: {
    readonly nodes?: ReadonlyArray<{
      readonly status?: unknown;
      readonly conclusion?: unknown;
      readonly workflowRun?: {
        readonly event?: unknown;
        readonly workflow?: { readonly name?: unknown } | null;
      } | null;
    } | null>;
  } | null;
}

function deploymentSignal(state: unknown): WorkDeployment | null {
  // A deployment later replaced by a newer one turns inactive; it did go out.
  if (state === "SUCCESS" || state === "INACTIVE") return "deployed";
  if (state === "FAILURE" || state === "ERROR") return "failed";
  if (typeof state === "string") return "pending";
  return null;
}

function workflowSignal(status: unknown, conclusion: unknown): WorkDeployment | "skipped" {
  if (status !== "COMPLETED") return "pending";
  if (conclusion === "SUCCESS") return "deployed";
  if (conclusion === "FAILURE" || conclusion === "TIMED_OUT" || conclusion === "STARTUP_FAILURE")
    return "failed";
  return "skipped";
}

function commitOf(raw: RawCommit | null): BranchCommit | null {
  if (!raw || typeof raw.oid !== "string" || typeof raw.committedDate !== "string") return null;
  const signals: Array<WorkDeployment | "skipped"> = [];
  for (const deployment of raw.deployments?.nodes ?? []) {
    if (typeof deployment?.environment !== "string") continue;
    if (!PRODUCTION_ENVIRONMENT.test(deployment.environment)) continue;
    const signal = deploymentSignal(deployment.latestStatus?.state);
    if (signal) signals.push(signal);
  }
  for (const suite of raw.checkSuites?.nodes ?? []) {
    const run = suite?.workflowRun;
    const name = run?.workflow?.name;
    if (typeof name !== "string" || !DEPLOY_WORKFLOW.test(name)) continue;
    if (typeof run?.event !== "string" || IGNORED_EVENTS.has(run.event)) continue;
    signals.push(workflowSignal(suite?.status, suite?.conclusion));
  }
  return { oid: raw.oid, committedDate: raw.committedDate, signals };
}

/** Each branch's newest commits, newest first, by `owner/name#branch` lowercase owner/name. */
export function parseGitHubDeployments(
  branches: ReadonlyArray<DeployBranch>,
  response: unknown,
): ReadonlyMap<string, ReadonlyArray<BranchCommit>> {
  const data = (response as { data?: Record<string, unknown> } | null)?.data ?? {};
  const result = new Map<string, ReadonlyArray<BranchCommit>>();
  for (const [index, branch] of branches.entries()) {
    const nodes = (
      data[`b${index}`] as {
        ref?: { target?: { history?: { nodes?: ReadonlyArray<RawCommit | null> } } } | null;
      } | null
    )?.ref?.target?.history?.nodes;
    if (!nodes) continue;
    result.set(
      branchKey(branch),
      nodes.flatMap((node) => {
        const commit = commitOf(node);
        return commit ? [commit] : [];
      }),
    );
  }
  return result;
}

/**
 * A merge's rollout from its branch's newest commits. Commits are newest first, so everything
 * up to the merge commit came after it; when the merge commit is older than what was read, every
 * commit read is newer. Unknown when the branch shows no deploys at all, so repositories that
 * never deploy show no state rather than waiting forever.
 */
export function deploymentOf(
  request: Pick<WorkGitHubPullRequest, "mergedAt">,
  merge: MergeCommit,
  commits: ReadonlyArray<BranchCommit>,
): WorkDeployment | undefined {
  if (!commits.some((commit) => commit.signals.length > 0)) return undefined;
  const index = commits.findIndex((commit) => commit.oid === merge.oid);
  const mergedAt = Date.parse(request.mergedAt ?? "");
  const after =
    index >= 0
      ? commits.slice(0, index + 1)
      : commits.filter((commit) => Date.parse(commit.committedDate) >= mergedAt);
  const signals = new Set(after.flatMap((commit) => commit.signals));
  if (signals.has("deployed")) return "deployed";
  if (signals.has("failed") && !signals.has("pending")) return "failed";
  return "pending";
}

/** The merged pull requests with what the branches showed; others keep their last state. */
export function withDeployments(
  merged: ReadonlyArray<WorkGitHubPullRequest>,
  checked: ReadonlyArray<WorkGitHubPullRequest>,
  mergeCommits: ReadonlyMap<string, MergeCommit>,
  branches: ReadonlyMap<string, ReadonlyArray<BranchCommit>>,
): WorkGitHubPullRequest[] {
  const checkedUrls = new Set(checked.map((request) => request.url));
  return merged.map((request) => {
    const merge = mergeCommits.get(request.url);
    const commits = merge
      ? branches.get(branchKey({ repository: request.repository, base: merge.base }))
      : undefined;
    if (!merge || !commits || !checkedUrls.has(request.url)) return request;
    const deployment = deploymentOf(request, merge, commits);
    const { deployment: _previous, ...rest } = request;
    return deployment ? { ...rest, deployment } : rest;
  });
}
