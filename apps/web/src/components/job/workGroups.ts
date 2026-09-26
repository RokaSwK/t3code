import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  legacyThreadPullRequestKey,
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import {
  parseSlackThreadUrl,
  type ScopedThreadRef,
  type ThreadPullRequestSnapshot,
} from "@t3tools/contracts";

export type WorkThread = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "projectId"
  | "title"
  | "updatedAt"
  | "archivedAt"
  | "settledAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "hasActionableProposedPlan"
  | "latestTurn"
  | "backgroundLiveness"
  | "linkedSlackThreads"
  | "pullRequests"
  | "linkedPullRequest"
  | "branchPullRequest"
>;

export type WorkStatus = "needs" | "working" | "waiting" | "done";

export interface WorkPullRequest {
  readonly key: string;
  readonly url: string;
  readonly repository: string;
  readonly number: number;
  readonly threadRef: ScopedThreadRef;
  readonly snapshot: ThreadPullRequestSnapshot | null;
}

export interface WorkGroup {
  readonly id: string;
  readonly threads: ReadonlyArray<WorkThread>;
  readonly pullRequests: ReadonlyArray<WorkPullRequest>;
  readonly slackLinks: ReadonlyArray<string>;
  readonly status: WorkStatus;
  readonly reason: string;
  readonly updatedAt: string;
}

function pullRequestsOf(thread: WorkThread): WorkPullRequest[] {
  const links = visibleThreadPullRequests(thread.pullRequests);
  if (thread.pullRequests.length > 0) {
    return links.map((link) => ({
      key: threadPullRequestKeyOf(link),
      url: link.url,
      repository: link.repository,
      number: link.number,
      threadRef: { environmentId: thread.environmentId, threadId: thread.id },
      snapshot: link.snapshot,
    }));
  }
  const legacy = [thread.linkedPullRequest, thread.branchPullRequest].filter(
    (link) => link != null,
  );
  return legacy.map((link) => ({
    key: threadPullRequestKeyOf(legacyThreadPullRequestKey(link)),
    url: link.url,
    repository: link.repository,
    number: link.number,
    threadRef: { environmentId: thread.environmentId, threadId: thread.id },
    snapshot: null,
  }));
}

function statusOf(
  threads: ReadonlyArray<WorkThread>,
  pullRequests: ReadonlyArray<WorkPullRequest>,
): Pick<WorkGroup, "status" | "reason"> {
  if (threads.some((thread) => thread.hasPendingApprovals)) {
    return { status: "needs", reason: "Agent needs approval" };
  }
  if (threads.some((thread) => thread.hasPendingUserInput)) {
    return { status: "needs", reason: "Agent needs an answer" };
  }
  if (threads.some((thread) => thread.hasActionableProposedPlan)) {
    return { status: "needs", reason: "Plan ready to review" };
  }
  if (threads.some((thread) => thread.latestTurn?.state === "error")) {
    return { status: "needs", reason: "Agent stopped with an error" };
  }
  const open = pullRequests.filter((request) => request.snapshot?.state === "open");
  if (open.some((request) => request.snapshot?.mergeability === "conflicting")) {
    return { status: "needs", reason: "PR has a merge conflict" };
  }
  if (open.some((request) => request.snapshot?.checksState === "failing")) {
    return { status: "needs", reason: "PR checks failing" };
  }
  if (open.some((request) => request.snapshot?.reviewDecision === "changes-requested")) {
    return { status: "needs", reason: "Changes requested on PR" };
  }
  if (
    threads.some(
      (thread) => thread.latestTurn?.state === "running" || thread.backgroundLiveness === "working",
    )
  ) {
    return { status: "working", reason: "Agent working" };
  }
  if (pullRequests.some((request) => request.snapshot === null)) {
    return { status: "waiting", reason: "Waiting for PR status" };
  }
  if (open.some((request) => request.snapshot?.checksState === "pending")) {
    return { status: "waiting", reason: "PR checks running" };
  }
  if (open.some((request) => request.snapshot?.reviewDecision === "review-required")) {
    return { status: "waiting", reason: "PR review required" };
  }
  if (threads.some((thread) => thread.backgroundLiveness === "monitoring")) {
    return { status: "waiting", reason: "Agent monitoring" };
  }
  if (open.length > 0) return { status: "working", reason: "PR open" };
  if (threads.some((thread) => thread.archivedAt === null && thread.settledAt === null)) {
    return { status: "working", reason: "T3 thread active" };
  }
  return { status: "done", reason: "Work completed" };
}

/** Group threads that refer to the same PR or Slack conversation, then derive attention. */
export function buildWorkGroups(source: ReadonlyArray<WorkThread>): WorkGroup[] {
  const threads = source.filter(
    (thread) =>
      thread.archivedAt === null ||
      pullRequestsOf(thread).length > 0 ||
      (thread.linkedSlackThreads?.length ?? 0) > 0,
  );
  const parent = threads.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[index] !== index) {
      const next = parent[index]!;
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const seen = new Map<string, number>();
  for (const [index, thread] of threads.entries()) {
    const keys = [
      ...pullRequestsOf(thread).map((request) => `pr:${request.key}`),
      ...(thread.linkedSlackThreads ?? []).map(
        (url) => `slack:${parseSlackThreadUrl(url)?.url ?? url}`,
      ),
    ];
    for (const key of keys) {
      const other = seen.get(key);
      if (other === undefined) seen.set(key, index);
      else parent[find(index)] = find(other);
    }
  }
  const buckets = new Map<number, WorkThread[]>();
  for (const [index, thread] of threads.entries()) {
    const root = find(index);
    const bucket = buckets.get(root) ?? [];
    bucket.push(thread);
    buckets.set(root, bucket);
  }
  return [...buckets.values()].map((group): WorkGroup => {
    const pullRequests = new Map<string, WorkPullRequest>();
    const slackLinks = new Set<string>();
    for (const thread of group) {
      for (const request of pullRequestsOf(thread)) {
        const previous = pullRequests.get(request.key);
        if (!previous || (request.snapshot?.syncedAt ?? "") > (previous.snapshot?.syncedAt ?? ""))
          pullRequests.set(request.key, request);
      }
      for (const link of thread.linkedSlackThreads ?? []) {
        slackLinks.add(parseSlackThreadUrl(link)?.url ?? link);
      }
    }
    const ordered = group.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const requests = [...pullRequests.values()];
    return {
      id: group.map((thread) => `${thread.environmentId}:${thread.id}`).toSorted()[0]!,
      threads: ordered,
      pullRequests: requests,
      slackLinks: [...slackLinks],
      ...statusOf(group, requests),
      updatedAt: ordered[0]!.updatedAt,
    };
  });
}
