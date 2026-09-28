/**
 * Work: which Slack conversations, T3 threads, and pull requests need you, and why. Shared so
 * the Work page and the Work agent's tools see the same groups and the same reasons.
 *
 * @module work
 */
import {
  legacyThreadPullRequestKey,
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "./threadPullRequests.ts";
import {
  type EnvironmentId,
  type OrchestrationThreadShell,
  type ProjectId,
  type ServerSettings,
  parseSlackThreadUrl,
  SLACK_DONE_REACTIONS,
  type ScopedThreadRef,
  type SlackDismissedThread,
  type SlackThread,
  type ThreadPullRequestSnapshot,
  type WorkGitHubPullRequest,
  type WorkItemMark,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export type WorkThread = { readonly environmentId: EnvironmentId } & Pick<
  OrchestrationThreadShell,
  | "id"
  | "projectId"
  | "title"
  | "updatedAt"
  | "archivedAt"
  | "settledAt"
  | "waitingForMergeAt"
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
  /** The Slack conversation this work is about, when it is one of yours. */
  readonly conversation: SlackThread | null;
  readonly threads: ReadonlyArray<WorkThread>;
  readonly pullRequests: ReadonlyArray<WorkPullRequest>;
  readonly slackLinks: ReadonlyArray<string>;
  readonly status: WorkStatus;
  readonly reason: string;
  readonly updatedAt: string;
  /** Marked done here, and not reopened by a later reply from someone else. */
  readonly markedDone: boolean;
  /** Someone the conversation was handed to; it is watched, not yours to act on. */
  readonly owner: WorkOwner | null;
  /** Someone you are waiting on, until another person replies after `at`. */
  readonly waitingOn: (WorkOwner & { readonly at: number }) | null;
  /** A pull request from your GitHub queue that nothing else here is about. */
  readonly pullRequest: WorkGitHubPullRequest | null;
  /** Whether that pull request waits for your review or is your own. */
  readonly pullRequestRole: "review" | "authored" | null;
}

export interface WorkOwner {
  readonly userId: string;
  readonly name: string;
  readonly avatarUrl?: string | undefined;
}

/** A conversation where only you or Devin spoke last goes quiet into Done after this. */
export const WORK_QUIET_MS = 3 * 24 * 60 * 60_000;
/** Without Devin's API, Devin counts as working this long after its last message. */
const DEVIN_RECENT_MS = 15 * 60_000;

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

type Attention = Pick<WorkGroup, "status" | "reason">;

/** An agent in a T3 thread is waiting on you. */
function agentNeeds(threads: ReadonlyArray<WorkThread>): Attention | null {
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
  return null;
}

function openPullRequests(pullRequests: ReadonlyArray<WorkPullRequest>) {
  return pullRequests.filter((request) => request.snapshot?.state === "open");
}

function pullRequestNeeds(pullRequests: ReadonlyArray<WorkPullRequest>): Attention | null {
  const open = openPullRequests(pullRequests);
  if (open.some((request) => request.snapshot?.mergeability === "conflicting")) {
    return { status: "needs", reason: "PR has a merge conflict" };
  }
  if (open.some((request) => request.snapshot?.checksState === "failing")) {
    return { status: "needs", reason: "PR checks failing" };
  }
  if (open.some((request) => request.snapshot?.reviewDecision === "changes-requested")) {
    return { status: "needs", reason: "Changes requested on PR" };
  }
  return null;
}

function agentWorking(threads: ReadonlyArray<WorkThread>): boolean {
  return threads.some(
    (thread) => thread.latestTurn?.state === "running" || thread.backgroundLiveness === "working",
  );
}

function pullRequestWaiting(pullRequests: ReadonlyArray<WorkPullRequest>): Attention | null {
  if (pullRequests.some((request) => request.snapshot === null)) {
    return { status: "waiting", reason: "Waiting for PR status" };
  }
  const open = openPullRequests(pullRequests);
  if (open.some((request) => request.snapshot?.checksState === "pending")) {
    return { status: "waiting", reason: "PR checks running" };
  }
  if (open.some((request) => request.snapshot?.reviewDecision === "review-required")) {
    return { status: "waiting", reason: "PR review required" };
  }
  return null;
}

function statusOf(
  threads: ReadonlyArray<WorkThread>,
  pullRequests: ReadonlyArray<WorkPullRequest>,
): Attention {
  const needs = agentNeeds(threads) ?? pullRequestNeeds(pullRequests);
  if (needs) return needs;
  if (threads.some((thread) => thread.waitingForMergeAt != null))
    return { status: "waiting", reason: "Waiting for merge" };
  if (agentWorking(threads)) return { status: "working", reason: "Agent working" };
  const waiting = pullRequestWaiting(pullRequests);
  if (waiting) return waiting;
  if (threads.some((thread) => thread.backgroundLiveness === "monitoring")) {
    return { status: "waiting", reason: "Agent monitoring" };
  }
  if (openPullRequests(pullRequests).length > 0) return { status: "working", reason: "PR open" };
  if (threads.some((thread) => thread.archivedAt === null && thread.settledAt === null)) {
    return { status: "working", reason: "T3 thread active" };
  }
  return { status: "done", reason: "Work completed" };
}

/** What your own open pull request is waiting on, from GitHub. */
function authoredPullRequestAttention(pullRequest: WorkGitHubPullRequest): Attention {
  if (pullRequest.conflicting) return { status: "needs", reason: "PR has a merge conflict" };
  if (pullRequest.checks === "failing") return { status: "needs", reason: "PR checks failing" };
  if (pullRequest.review === "changes-requested") {
    return { status: "needs", reason: "Changes requested on PR" };
  }
  if (pullRequest.isDraft) return { status: "working", reason: "Draft PR" };
  if (pullRequest.review === "approved" && pullRequest.checks !== "pending") {
    return { status: "needs", reason: "PR approved, ready to merge" };
  }
  if (pullRequest.checks === "pending") return { status: "waiting", reason: "PR checks running" };
  return { status: "waiting", reason: "PR waiting for review" };
}

/** Problems on a conversation's pull requests that GitHub reports, worst first. */
function linkedPullRequestAttention(
  details: ReadonlyArray<WorkGitHubPullRequest>,
): Attention | null {
  const attentions = details.map(authoredPullRequestAttention);
  return (
    attentions.find((attention) => attention.reason === "PR has a merge conflict") ??
    attentions.find((attention) => attention.reason === "PR checks failing") ??
    attentions.find((attention) => attention.reason === "Changes requested on PR") ??
    attentions.find((attention) => attention.reason === "PR approved, ready to merge") ??
    null
  );
}

const pullRequestKey = (request: { url: string; repository: string; number: number }) =>
  threadPullRequestKeyOf(legacyThreadPullRequestKey(request));

/** Stable identities keep ignored/planned work attached when a GitHub row joins Slack. */
export function workItemKeys(group: WorkGroup): string[] {
  return [
    ...group.slackLinks.map(slackKey),
    ...group.threads.map((thread) => `thread:${thread.environmentId}:${thread.id}`),
    ...group.pullRequests.map((request) => `pr:${pullRequestKey(request)}`),
    ...(group.conversation?.pullRequests ?? []).map((request) => `pr:${pullRequestKey(request)}`),
    ...(group.pullRequest ? [`pr:${pullRequestKey(group.pullRequest)}`] : []),
  ];
}

export function workItemTitle(group: WorkGroup): string {
  return group.conversation
    ? slackMessageSummary(group.conversation.markdown) || "Work item"
    : (group.pullRequest?.title ?? group.threads[0]?.title ?? "Work item");
}

export function workMatchesMarks(
  keys: ReadonlyArray<string>,
  marks: ReadonlyArray<WorkItemMark>,
): boolean {
  const marked = new Set(marks.flatMap((mark) => mark.keys));
  return keys.some((key) => marked.has(key));
}

export function slackWorkItemKeys(thread: SlackThread): string[] {
  return [
    slackKey(thread.permalink),
    ...(thread.pullRequests ?? []).map((request) => `pr:${pullRequestKey(request)}`),
  ];
}

export function slackTsToMs(ts: string): number {
  return Math.floor(Number.parseFloat(ts) * 1000);
}

/** Newest activity in a conversation and the T3 threads working on it. */
function lastActivityMs(conversation: SlackThread, threads: ReadonlyArray<WorkThread>): number {
  return Math.max(
    slackTsToMs(conversation.ts),
    conversation.latestReplyTs ? slackTsToMs(conversation.latestReplyTs) : 0,
    conversation.lastReply ? slackTsToMs(conversation.lastReply.ts) : 0,
    ...threads.map((thread) => Date.parse(thread.updatedAt) || 0),
  );
}

/**
 * Whether one of your Slack conversations needs you. Anything waiting on you comes first, then
 * agents at work, then whoever the conversation is waiting on. A conversation where you or
 * Devin spoke last and nothing is open goes quiet into Done after {@link WORK_QUIET_MS}.
 */
function conversationStatusOf(
  conversation: SlackThread,
  threads: ReadonlyArray<WorkThread>,
  pullRequests: ReadonlyArray<WorkPullRequest>,
  markedDone: boolean,
  waitingOn: WorkGroup["waitingOn"],
  pullRequestDetails: ReadonlyMap<string, WorkGitHubPullRequest>,
  now: number,
): Attention {
  if (threads.some((thread) => thread.waitingForMergeAt != null)) {
    const needs = agentNeeds(threads) ?? pullRequestNeeds(pullRequests);
    if (needs) return needs;
    const sessions = conversation.devin?.sessions ?? [];
    if (sessions.some((session) => session.state === "waiting"))
      return { status: "needs", reason: "Devin is waiting for you" };
    if (sessions.some((session) => session.state === "error"))
      return { status: "needs", reason: "Devin stopped with an error" };
    const trouble = linkedPullRequestAttention(
      (conversation.pullRequests ?? []).flatMap((request) => {
        const detail = pullRequestDetails.get(pullRequestKey(request));
        return detail ? [detail] : [];
      }),
    );
    if (trouble && trouble.reason !== "PR approved, ready to merge") return trouble;
    return { status: "waiting", reason: "Waiting for merge" };
  }
  const tick = slackThreadDoneReason({ ...conversation, pullRequests: [] });
  if (tick) return { status: "done", reason: tick };
  if (markedDone) return { status: "done", reason: "Marked done" };
  const needs = agentNeeds(threads);
  if (needs) return needs;
  const sessions = conversation.devin?.sessions ?? [];
  if (sessions.some((session) => session.state === "waiting")) {
    return { status: "needs", reason: "Devin is waiting for you" };
  }
  if (sessions.some((session) => session.state === "error")) {
    return { status: "needs", reason: "Devin stopped with an error" };
  }
  const pullRequestProblem =
    pullRequestNeeds(pullRequests) ??
    linkedPullRequestAttention(
      (conversation.pullRequests ?? []).flatMap((request) => {
        const detail =
          request.state !== "merged" && request.state !== "closed"
            ? pullRequestDetails.get(pullRequestKey(request))
            : undefined;
        return detail ? [detail] : [];
      }),
    );
  if (pullRequestProblem) return pullRequestProblem;
  const lastReply = conversation.lastReply;
  // Waiting on someone holds until another person replies after it was set.
  const answered =
    lastReply?.by === "other" && waitingOn !== null && slackTsToMs(lastReply.ts) > waitingOn.at;
  if (waitingOn !== null && !answered) {
    return { status: "waiting", reason: `Waiting on ${waitingOn.name}` };
  }
  if (lastReply?.by === "other")
    return { status: "needs", reason: `${lastReply.authorName} replied` };
  const quiet = now - lastActivityMs(conversation, threads) > WORK_QUIET_MS;
  if (!lastReply && !conversation.startedByMe) {
    return quiet
      ? { status: "done", reason: "Quiet for 3 days" }
      : { status: "needs", reason: "No reply yet" };
  }
  if (agentWorking(threads)) return { status: "working", reason: "Agent working" };
  const lastDevinMs = conversation.devin ? slackTsToMs(conversation.devin.lastMessageTs) : 0;
  const devinWorking =
    sessions.some((session) => session.state === "working") ||
    (conversation.devin !== undefined &&
      !conversation.devin.stopped &&
      sessions.every((session) => session.state === undefined) &&
      lastReply?.by === "devin" &&
      now - lastDevinMs < DEVIN_RECENT_MS);
  if (devinWorking) return { status: "working", reason: "Devin working" };
  const states = [
    ...(conversation.pullRequests ?? []).map((request) => request.state),
    ...pullRequests.map((request) => request.snapshot?.state),
  ];
  if (states.length > 0 && states.every((state) => state === "merged" || state === "closed")) {
    const merged = states.every((state) => state === "merged");
    const count = new Set([
      ...(conversation.pullRequests ?? []).map((request) => request.url),
      ...pullRequests.map((request) => request.url),
    ]).size;
    return {
      status: "done",
      reason: merged ? (count === 1 ? "PR merged" : "PRs merged") : "PRs merged or closed",
    };
  }
  const waiting = pullRequestWaiting(pullRequests);
  if (waiting) return waiting;
  // A PR is out and nobody else has spoken since: it is with its reviewers now.
  const openPullRequest =
    (conversation.pullRequests ?? []).some((request) => request.state === "open") ||
    openPullRequests(pullRequests).length > 0;
  if (openPullRequest && (lastReply?.by === "devin" || lastReply?.by === "me")) {
    return { status: "waiting", reason: "PR open, waiting for review" };
  }
  if (lastReply?.by === "devin") {
    if (quiet) return { status: "done", reason: "Quiet for 3 days" };
    return {
      status: "needs",
      reason: sessions.some((session) => session.state === "finished")
        ? "Devin finished"
        : "Devin replied",
    };
  }
  if (lastReply?.by === "me") {
    if (quiet) return { status: "done", reason: "Quiet for 3 days" };
    return { status: "waiting", reason: "Waiting for a reply" };
  }
  if (threads.some((thread) => thread.backgroundLiveness === "monitoring")) {
    return { status: "waiting", reason: "Agent monitoring" };
  }
  const slackOpen = (conversation.pullRequests ?? []).some((request) => request.state === "open");
  if (slackOpen || openPullRequests(pullRequests).length > 0) {
    return { status: "working", reason: "PR open" };
  }
  if (threads.some((thread) => thread.archivedAt === null && thread.settledAt === null)) {
    return { status: "working", reason: "T3 thread active" };
  }
  if (quiet) return { status: "done", reason: "Quiet for 3 days" };
  return { status: "waiting", reason: "Following" };
}

function slackKey(url: string): string {
  return `slack:${parseSlackThreadUrl(url)?.url ?? url}`;
}

/** Remove every Slack mention already represented by a work group, not just its leading one. */
export function ungroupedWorkChannelThreads(
  threads: ReadonlyArray<SlackThread>,
  groups: ReadonlyArray<WorkGroup>,
) {
  const represented = new Set(groups.flatMap((group) => group.slackLinks.map(slackKey)));
  return threads.filter((thread) => !represented.has(slackKey(thread.permalink)));
}

/**
 * Group threads and Slack conversations that refer to the same PR or Slack conversation, then
 * derive attention. A group with one of your conversations is led by it; the rest are T3 work.
 */
export function buildWorkGroups(
  source: ReadonlyArray<WorkThread>,
  options: {
    readonly conversations?: ReadonlyArray<SlackThread>;
    /** Channel threads join your work when they share a PR or T3 thread with it. */
    readonly channelThreads?: ReadonlyArray<SlackThread>;
    readonly dismissed?: ReadonlyArray<SlackDismissedThread>;
    readonly owners?: ReadonlyArray<
      WorkOwner & { readonly channelId: string; readonly ts: string }
    >;
    readonly waits?: ReadonlyArray<
      WorkOwner & { readonly channelId: string; readonly ts: string; readonly at: number }
    >;
    /** Your GitHub queue: pull requests waiting for your review, and your own open ones. */
    readonly github?: {
      readonly reviewRequests: ReadonlyArray<WorkGitHubPullRequest>;
      readonly authored: ReadonlyArray<WorkGitHubPullRequest>;
      /** Owners whose pull requests count, lowercase or not; absent means every owner. */
      readonly owners?: ReadonlyArray<string>;
    };
    /** Ms since the epoch; conversations age against it. */
    readonly now: number;
  },
): WorkGroup[] {
  const followed = options.conversations ?? [];
  const conversationKeys = new Set(followed.map((thread) => `${thread.channelId}:${thread.ts}`));
  const conversations = [
    ...followed,
    ...(options.channelThreads ?? []).filter((thread) => {
      const key = `${thread.channelId}:${thread.ts}`;
      if (conversationKeys.has(key)) return false;
      conversationKeys.add(key);
      return true;
    }),
  ];
  const owners = options.github?.owners
    ? new Set(options.github.owners.map((owner) => owner.toLowerCase()))
    : null;
  const githubKeys = new Set(
    [...(options.github?.reviewRequests ?? []), ...(options.github?.authored ?? [])]
      .filter((request) => !owners || owners.has(gitHubOwnerOf(request)))
      .map(pullRequestKey),
  );
  const now = options.now;
  const threads = source.filter(
    (thread) =>
      thread.archivedAt === null ||
      pullRequestsOf(thread).length > 0 ||
      (thread.linkedSlackThreads?.length ?? 0) > 0,
  );
  // Nodes are threads first, then conversations.
  const size = threads.length + conversations.length;
  const parent = Array.from({ length: size }, (_, index) => index);
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
  const join = (index: number, keys: ReadonlyArray<string>) => {
    for (const key of keys) {
      const other = seen.get(key);
      if (other === undefined) seen.set(key, index);
      else parent[find(index)] = find(other);
    }
  };
  for (const [index, thread] of threads.entries()) {
    join(index, [
      ...pullRequestsOf(thread).map((request) => `pr:${request.key}`),
      ...(thread.linkedSlackThreads ?? []).map(slackKey),
    ]);
  }
  for (const [offset, conversation] of conversations.entries()) {
    join(threads.length + offset, [
      slackKey(conversation.permalink),
      ...(conversation.pullRequests ?? []).map((request) => `pr:${pullRequestKey(request)}`),
    ]);
  }
  const buckets = new Map<number, number[]>();
  for (let index = 0; index < size; index += 1) {
    const root = find(index);
    const bucket = buckets.get(root) ?? [];
    bucket.push(index);
    buckets.set(root, bucket);
  }
  const dismissedAt = new Map(
    (options.dismissed ?? []).map((ref) => [
      `${ref.channelId}:${ref.ts}`,
      ref.at ?? Number.POSITIVE_INFINITY,
    ]),
  );
  const pullRequestDetails = new Map(
    (options.github?.authored ?? []).map(
      (pullRequest) => [pullRequestKey(pullRequest), pullRequest] as const,
    ),
  );
  const waitOf = new Map(
    (options.waits ?? []).map((entry) => [`${entry.channelId}:${entry.ts}`, entry] as const),
  );
  const ownerOf = new Map(
    (options.owners ?? []).map((entry) => [`${entry.channelId}:${entry.ts}`, entry] as const),
  );
  const relevantBuckets = [...buckets.values()].filter((members) =>
    members.some(
      (index) =>
        index < threads.length + followed.length ||
        (conversations[index - threads.length]?.pullRequests ?? []).some((request) =>
          githubKeys.has(pullRequestKey(request)),
        ),
    ),
  );
  const grouped = relevantBuckets.map((members): WorkGroup => {
    const group = members.filter((index) => index < threads.length).map((index) => threads[index]!);
    // Keep followed conversations in front of channel mentions; retain every linked PR.
    const relatedConversations = members
      .filter((index) => index >= threads.length)
      .sort(
        (left, right) =>
          Number(right < threads.length + followed.length) -
            Number(left < threads.length + followed.length) ||
          lastActivityMs(conversations[right - threads.length]!, []) -
            lastActivityMs(conversations[left - threads.length]!, []),
      )
      .map((index) => conversations[index - threads.length]!);
    const primary = relatedConversations[0];
    const conversationRequests = new Map<
      string,
      NonNullable<SlackThread["pullRequests"]>[number]
    >();
    for (const related of relatedConversations) {
      for (const request of related.pullRequests ?? []) {
        const key = pullRequestKey(request);
        const previous = conversationRequests.get(key);
        if (!previous || (!previous.state && request.state)) conversationRequests.set(key, request);
      }
    }
    const conversation = primary
      ? { ...primary, pullRequests: [...conversationRequests.values()] }
      : null;
    const pullRequests = new Map<string, WorkPullRequest>();
    const slackLinks = new Set<string>();
    for (const related of relatedConversations)
      slackLinks.add(parseSlackThreadUrl(related.permalink)?.url ?? related.permalink);
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
    const ordered = [...group].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const requests = [...pullRequests.values()];
    if (conversation) {
      const doneAt = dismissedAt.get(`${conversation.channelId}:${conversation.ts}`);
      const reopened =
        conversation.lastReply?.by === "other" &&
        doneAt !== undefined &&
        slackTsToMs(conversation.lastReply.ts) > doneAt;
      const markedDone = doneAt !== undefined && !reopened;
      return {
        id: `slack:${conversation.channelId}:${conversation.ts}`,
        conversation,
        threads: ordered,
        pullRequests: requests,
        slackLinks: [...slackLinks],
        ...conversationStatusOf(
          conversation,
          ordered,
          requests,
          markedDone,
          waitOf.get(`${conversation.channelId}:${conversation.ts}`) ?? null,
          pullRequestDetails,
          now,
        ),
        updatedAt: DateTime.formatIso(DateTime.makeUnsafe(lastActivityMs(conversation, ordered))),
        markedDone,
        owner: ownerOf.get(`${conversation.channelId}:${conversation.ts}`) ?? null,
        waitingOn: waitOf.get(`${conversation.channelId}:${conversation.ts}`) ?? null,
        pullRequest: null,
        pullRequestRole: null,
      };
    }
    return {
      id: group.map((thread) => `${thread.environmentId}:${thread.id}`).sort()[0]!,
      conversation: null,
      threads: ordered,
      pullRequests: requests,
      slackLinks: [...slackLinks],
      ...statusOf(group, requests),
      updatedAt: ordered[0]!.updatedAt,
      markedDone: false,
      owner: null,
      waitingOn: null,
      pullRequest: null,
      pullRequestRole: null,
    };
  });

  // Pull requests in your GitHub queue that no conversation or thread here is about.
  const covered = new Set(
    grouped.flatMap((group) => [
      ...group.pullRequests.map(pullRequestKey),
      ...(group.conversation?.pullRequests ?? []).map(pullRequestKey),
    ]),
  );
  const standalone = (
    pullRequest: WorkGitHubPullRequest,
    role: "review" | "authored",
  ): WorkGroup => ({
    id: `github:${pullRequestKey(pullRequest)}`,
    conversation: null,
    threads: [],
    pullRequests: [],
    slackLinks: [],
    ...(role === "review"
      ? {
          status: "needs" as const,
          reason: pullRequest.author
            ? `Review requested by ${pullRequest.author}`
            : "Review requested",
        }
      : authoredPullRequestAttention(pullRequest)),
    updatedAt: pullRequest.updatedAt,
    markedDone: false,
    owner: null,
    waitingOn: null,
    pullRequest,
    pullRequestRole: role,
  });
  const listed = new Set(covered);
  const queue: WorkGroup[] = [];
  for (const [role, list] of [
    ["review", options.github?.reviewRequests ?? []],
    ["authored", options.github?.authored ?? []],
  ] as const) {
    for (const pullRequest of list) {
      const key = pullRequestKey(pullRequest);
      if (listed.has(key)) continue;
      if (owners && !owners.has(gitHubOwnerOf(pullRequest))) continue;
      listed.add(key);
      queue.push(standalone(pullRequest, role));
    }
  }
  return [...grouped, ...queue];
}

/** The user or organization a pull request's repository belongs to, lowercase. */
export function gitHubOwnerOf(pullRequest: Pick<WorkGitHubPullRequest, "repository">): string {
  return (pullRequest.repository.split("/")[0] ?? "").toLowerCase();
}

/**
 * Why a Slack thread no longer needs attention, or null while it still might: a tick reaction
 * on its root from anyone, or every PR it links merged or closed.
 */
export function slackThreadDoneReason(thread: SlackThread): string | null {
  if (thread.reactions.some((reaction) => SLACK_DONE_REACTIONS.has(reaction.name))) {
    return "Marked ✅ in Slack";
  }
  const requests = thread.pullRequests ?? [];
  if (requests.length === 0) return null;
  if (requests.every((request) => request.state === "merged")) {
    return requests.length === 1 ? "PR merged" : "PRs merged";
  }
  if (requests.every((request) => request.state === "merged" || request.state === "closed")) {
    return requests.length === 1 ? "PR closed" : "PRs merged or closed";
  }
  return null;
}

type WorkProject = {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
};
type WorkConfig = { readonly settings: Pick<ServerSettings, "workProjectRootIds"> };

function normalizedRoot(root: string): string {
  return root.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

/** The personal fork starts with the Tuyo workspace, then uses explicit server settings. */
export function workRootsForEnvironment<Project extends WorkProject>(
  projects: ReadonlyArray<Project>,
  environmentId: EnvironmentId,
  config: WorkConfig | undefined,
): ReadonlyArray<Project> {
  if (!config) return [];
  const local = projects.filter((project) => project.environmentId === environmentId);
  const selected = config.settings.workProjectRootIds;
  if (selected !== undefined) {
    const ids = new Set<ProjectId>(selected);
    return local.filter((project) => ids.has(project.id));
  }
  return local.filter(
    (project) =>
      project.title.toLowerCase() === "tuyoinc" ||
      normalizedRoot(project.workspaceRoot).endsWith("/tuyoinc"),
  );
}

export function includedWorkProjects<Project extends WorkProject>(
  projects: ReadonlyArray<Project>,
  configs: ReadonlyMap<EnvironmentId, WorkConfig>,
): ReadonlyArray<Project> {
  const roots = new Map<EnvironmentId, ReadonlyArray<string>>();
  for (const environmentId of new Set(projects.map((project) => project.environmentId))) {
    roots.set(
      environmentId,
      workRootsForEnvironment(projects, environmentId, configs.get(environmentId)).map((project) =>
        normalizedRoot(project.workspaceRoot),
      ),
    );
  }
  return projects.filter((project) => {
    const path = normalizedRoot(project.workspaceRoot);
    return roots
      .get(project.environmentId)
      ?.some((root) => path === root || path.startsWith(`${root}/`));
  });
}

/** One line of plain text from a Slack message, for a row title. */
export function slackMessageSummary(markdown: string): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    // Devin ends its messages with icon links to the session and its settings.
    .replace(/\[\[[^\]]*\]\]\([^)]*\)/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    // Devin's automations post for you as "@you: request".
    .replace(/^\s*\*{0,2}@[^:*\n]{1,40}\*{0,2}:\s*/, "")
    // A bare link says little in a title; the words around it say more.
    .replace(/<?https?:\/\/\S+>?/g, " ")
    // Slack shows some links by their address without the scheme.
    .replace(/(?:^|\s)(?:www\.)?[\w-]+(?:\.[\w-]+)+\/\S*/g, " ")
    .replace(/[*_~`>#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text || "Shared a link";
}
