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
  now: number,
): Attention {
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
  const pullRequestProblem = pullRequestNeeds(pullRequests);
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

/**
 * Group threads and Slack conversations that refer to the same PR or Slack conversation, then
 * derive attention. A group with one of your conversations is led by it; the rest are T3 work.
 */
export function buildWorkGroups(
  source: ReadonlyArray<WorkThread>,
  options: {
    readonly conversations?: ReadonlyArray<SlackThread>;
    readonly dismissed?: ReadonlyArray<SlackDismissedThread>;
    readonly owners?: ReadonlyArray<
      WorkOwner & { readonly channelId: string; readonly ts: string }
    >;
    readonly waits?: ReadonlyArray<
      WorkOwner & { readonly channelId: string; readonly ts: string; readonly at: number }
    >;
    /** Ms since the epoch; conversations age against it. */
    readonly now: number;
  },
): WorkGroup[] {
  const conversations = options.conversations ?? [];
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
      ...(conversation.pullRequests ?? []).map(
        (request) =>
          `pr:${threadPullRequestKeyOf({
            host: "github.com",
            repository: request.repository,
            number: request.number,
            url: request.url,
          })}`,
      ),
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
  const waitOf = new Map(
    (options.waits ?? []).map((entry) => [`${entry.channelId}:${entry.ts}`, entry] as const),
  );
  const ownerOf = new Map(
    (options.owners ?? []).map((entry) => [`${entry.channelId}:${entry.ts}`, entry] as const),
  );
  return [...buckets.values()].map((members): WorkGroup => {
    const group = members.filter((index) => index < threads.length).map((index) => threads[index]!);
    // Rarely two of your conversations share a PR; the most recent one leads.
    const conversation =
      members
        .filter((index) => index >= threads.length)
        .map((index) => conversations[index - threads.length]!)
        .sort((left, right) => lastActivityMs(right, []) - lastActivityMs(left, []))[0] ?? null;
    const pullRequests = new Map<string, WorkPullRequest>();
    const slackLinks = new Set<string>();
    if (conversation)
      slackLinks.add(parseSlackThreadUrl(conversation.permalink)?.url ?? conversation.permalink);
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
          now,
        ),
        updatedAt: DateTime.formatIso(DateTime.makeUnsafe(lastActivityMs(conversation, ordered))),
        markedDone,
        owner: ownerOf.get(`${conversation.channelId}:${conversation.ts}`) ?? null,
        waitingOn: waitOf.get(`${conversation.channelId}:${conversation.ts}`) ?? null,
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
    };
  });
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
