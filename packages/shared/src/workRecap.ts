/**
 * What the Work recap counts as finished work and waiting work. Shared so the server builds the
 * recap and clients show the same rules.
 *
 * @module workRecap
 */
import type {
  EnvironmentId,
  ProjectId,
  SlackChannelKind,
  SlackState,
  SlackThread,
  ThreadPullRequestSnapshot,
  WorkGitHubPullRequest,
  WorkItemMark,
} from "@t3tools/contracts";

import { legacyThreadPullRequestKey, threadPullRequestKeyOf } from "./threadPullRequests.ts";
import {
  gitHubOwnerOf,
  slackMessageSummary,
  slackWorkItemKeys,
  workItemKeys,
  workItemTitle,
  workMatchesMarks,
  type WorkGroup,
  type WorkThread,
} from "./work.ts";

export interface WorkAccomplishment {
  readonly keys: ReadonlyArray<string>;
  readonly title: string;
  readonly at: number;
  readonly evidence: "Marked done" | "PR merged" | "Thread settled";
  readonly url?: string;
  readonly groupId?: string;
  /** The project the work happened in, for grouping. Slack-only and GitHub-only items have none. */
  readonly project?: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId };
  /** Where it came from, shown the way the Work list shows it. */
  readonly source: "slack" | "github" | "t3";
  readonly channel?: { readonly name: string; readonly kind: SlackChannelKind };
  readonly pullRequest?: {
    readonly label: string;
    readonly state: ThreadPullRequestSnapshot["state"];
    readonly isDraft: boolean;
  };
  /** The PR's head branch; items on one branch are one feature. */
  readonly branch?: string;
  /** Source lines across the item's known pull requests; see {@link workSourceLines}. */
  readonly sourceLines?: number;
  /** Replies in the item's Slack conversation. */
  readonly slackMessages?: number;
}

/** A candidate with its pull requests' source lines by URL, so merged duplicates sum once. */
type Candidate = WorkAccomplishment & { readonly lines?: Readonly<Record<string, number>> };

// Changed lines that show effort: tests, generated output, lockfiles, snapshots, and vendored
// code don't.
const NON_SOURCE_PATHS = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Gemfile\.lock|Podfile\.lock|Cargo\.lock|composer\.lock|poetry\.lock|uv\.lock|go\.sum)$/,
  /(^|\/)(__generated__|generated|__snapshots__)\/|\.(snap|min\.js|min\.css|generated\.\w+)$/,
  /(^|\/)(\.repos|vendor|vendored|third_party|third-party|node_modules)\//,
  /(^|\/)(spec|specs|test|tests|__tests__|__mocks__|e2e|cypress|playwright)\//,
  /(\.|_)(spec|test)\.\w+$|(^|\/)test_[^/]+\.py$|_test\.go$/,
];

/** Lines a pull request changed in source files, from GitHub's per-file counts. */
export function workSourceLines(
  files: ReadonlyArray<{
    readonly path: string;
    readonly additions: number;
    readonly deletions: number;
  }>,
): number {
  return files
    .filter((file) => !NON_SOURCE_PATHS.some((rule) => rule.test(file.path)))
    .reduce((total, file) => total + file.additions + file.deletions, 0);
}

/** What a piece of work's size is measured from. */
interface WorkSizeFacts {
  readonly sourceLines?: number | undefined;
  readonly slackMessages?: number | undefined;
}

/**
 * How big a piece of finished work is, with diminishing returns: the thousandth line or the
 * tenth Slack message adds less than the first ones. Work with no known size is 1.
 */
export function workRecapItemSize(item: WorkSizeFacts): number {
  return (
    1 + Math.log2(1 + (item.sourceLines ?? 0) / 25) + Math.log2(1 + (item.slackMessages ?? 0) / 2)
  );
}

/** A feature led by its biggest item: many small items don't outweigh one big one. */
export function workRecapFeatureSize(items: ReadonlyArray<WorkSizeFacts>): number {
  return Math.hypot(...items.map(workRecapItemSize));
}

function channelOf(thread: SlackThread) {
  return { channel: { name: thread.channelName, kind: thread.channelKind } };
}

/** The known source lines of these pull requests, by URL. */
function linesOf(
  urls: ReadonlyArray<string>,
  known: ReadonlyMap<string, WorkGitHubPullRequest>,
): { readonly lines?: Record<string, number> } {
  const lines: Record<string, number> = {};
  for (const url of urls) {
    const sourceLines = known.get(url)?.sourceLines;
    if (sourceLines !== undefined) lines[url] = sourceLines;
  }
  return Object.keys(lines).length > 0 ? { lines } : {};
}

function groupSize(group: WorkGroup, known: ReadonlyMap<string, WorkGitHubPullRequest>) {
  return {
    ...linesOf(
      [
        ...group.pullRequests.map((request) => request.url),
        ...(group.conversation?.pullRequests ?? []).map((request) => request.url),
        ...(group.pullRequest ? [group.pullRequest.url] : []),
      ],
      known,
    ),
    ...(group.conversation?.replyCount ? { slackMessages: group.conversation.replyCount } : {}),
  };
}

/**
 * A pull request names the work best. A linked thread can be any side conversation, so it only
 * names work that has no Slack message either.
 */
export function workGroupTitle(group: WorkGroup): string {
  return (
    group.pullRequests.find((request) => request.snapshot)?.snapshot?.title ??
    group.pullRequest?.title ??
    (group.conversation ? workItemTitle(group) : (group.threads[0]?.title ?? workItemTitle(group)))
  );
}

/** Completion dates are evidence, never the last update or the age of a quiet conversation. */
export function buildWorkAccomplishments(input: {
  readonly groups: ReadonlyArray<WorkGroup>;
  readonly threads: ReadonlyArray<WorkThread>;
  readonly slack: SlackState | null;
  readonly ignored: ReadonlyArray<WorkItemMark>;
  readonly githubOwners: ReadonlyArray<string> | undefined;
  /** Threads where some turn checkpointed file changes. */
  readonly changedThreadIds: ReadonlySet<string>;
  readonly since: number;
  readonly now: number;
}): WorkAccomplishment[] {
  const candidates: Candidate[] = [];
  const known = new Map(
    [...(input.slack?.authoredPullRequests ?? []), ...(input.slack?.mergedPullRequests ?? [])].map(
      (request) => [request.url, request] as const,
    ),
  );
  const ignoredKeys = new Set(input.ignored.flatMap((item) => item.keys));
  for (const group of input.groups) {
    const keys = workItemKeys(group);
    if (keys.some((key) => ignoredKeys.has(key))) for (const key of keys) ignoredKeys.add(key);
  }
  for (const group of input.groups) {
    const keys = workItemKeys(group);
    const project = projectOf(group.threads[0]);
    const doneAt = group.markedDone
      ? input.slack?.dismissed.find(
          (item) =>
            item.channelId === group.conversation?.channelId && item.ts === group.conversation.ts,
        )?.at
      : undefined;
    // Marking a conversation done is often just triage; it counts when you did the work.
    const didWork =
      group.threads.length > 0 ||
      group.pullRequests.length > 0 ||
      group.conversation?.startedByMe === true;
    if (doneAt !== undefined && didWork)
      candidates.push({
        keys,
        title: workGroupTitle(group),
        at: doneAt,
        evidence: "Marked done",
        groupId: group.id,
        source: "slack",
        ...groupSize(group, known),
        ...(group.conversation
          ? { url: group.conversation.permalink, ...channelOf(group.conversation) }
          : {}),
        ...project,
      });
    for (const request of group.pullRequests) {
      if (request.snapshot?.state !== "merged" || !request.snapshot.mergedAt) continue;
      candidates.push({
        keys,
        title: request.snapshot.title,
        at: Date.parse(request.snapshot.mergedAt),
        evidence: "PR merged",
        url: request.url,
        groupId: group.id,
        source: "github",
        pullRequest: {
          label: `${request.repository}#${request.number}`,
          state: "merged",
          isDraft: false,
        },
        branch: request.snapshot.headBranch,
        ...groupSize(group, known),
        ...project,
      });
    }
  }
  // Channel posts you only dismissed are inbox triage; your own conversations are work.
  for (const thread of [...(input.slack?.conversations ?? []), ...(input.slack?.threads ?? [])]) {
    if (thread.startedByMe !== true) continue;
    const doneAt = input.slack?.dismissed.find(
      (item) => item.channelId === thread.channelId && item.ts === thread.ts,
    )?.at;
    if (doneAt !== undefined)
      candidates.push({
        keys: slackWorkItemKeys(thread),
        title: slackMessageSummary(thread.markdown) || "Work item",
        at: doneAt,
        evidence: "Marked done",
        url: thread.permalink,
        source: "slack",
        ...(thread.replyCount ? { slackMessages: thread.replyCount } : {}),
        ...channelOf(thread),
      });
  }
  for (const thread of input.threads) {
    if (!thread.settledAt) continue;
    const group = input.groups.find((item) =>
      item.threads.some(
        (candidate) =>
          candidate.environmentId === thread.environmentId && candidate.id === thread.id,
      ),
    );
    // Questions and chores settle too. Only changed files or tracked work make an outcome.
    if (
      !input.changedThreadIds.has(thread.id) &&
      thread.pullRequests.length === 0 &&
      !group?.conversation &&
      !group?.pullRequests.length
    )
      continue;
    const link = thread.pullRequests.find((candidate) => candidate.snapshot);
    candidates.push({
      keys: group ? workItemKeys(group) : [`thread:${thread.environmentId}:${thread.id}`],
      title: thread.title,
      at: Date.parse(thread.settledAt),
      evidence: "Thread settled",
      source: "t3",
      ...(group
        ? { groupId: group.id, ...groupSize(group, known) }
        : linesOf(
            thread.pullRequests.map((request) => request.url),
            known,
          )),
      ...(link?.snapshot
        ? {
            pullRequest: {
              label: `${link.repository}#${link.number}`,
              state: link.snapshot.state,
              isDraft: link.snapshot.isDraft,
            },
            branch: link.snapshot.headBranch,
          }
        : {}),
      ...projectOf(thread),
    });
  }
  const owners = input.githubOwners
    ? new Set(input.githubOwners.map((owner) => owner.toLowerCase()))
    : null;
  for (const request of input.slack?.mergedPullRequests ?? []) {
    if (!request.mergedAt || (owners && !owners.has(gitHubOwnerOf(request)))) continue;
    candidates.push({
      keys: [`pr:${threadPullRequestKeyOf(legacyThreadPullRequestKey(request))}`],
      title: request.title,
      at: Date.parse(request.mergedAt),
      evidence: "PR merged",
      url: request.url,
      source: "github",
      pullRequest: {
        label: `${request.repository}#${request.number}`,
        state: "merged",
        isDraft: false,
      },
      ...linesOf([request.url], known),
    });
  }
  const result: Candidate[] = [];
  for (const item of [...candidates].sort((a, b) => b.at - a.at)) {
    if (
      !Number.isFinite(item.at) ||
      item.at < input.since ||
      item.at > input.now ||
      item.keys.some((key) => ignoredKeys.has(key))
    )
      continue;
    const matches = result.filter((known) => known.keys.some((key) => item.keys.includes(key)));
    if (matches.length === 0) result.push(item);
    else {
      const newest = matches[0]!;
      const all = [...matches, item];
      const project = all.find((known) => known.project)?.project;
      const pullRequest = all.find((known) => known.pullRequest)?.pullRequest;
      const url = all.find((known) => known.url)?.url;
      const branch = all.find((known) => known.branch)?.branch;
      const lines = Object.assign({}, ...all.map((known) => known.lines ?? {}));
      const slackMessages = Math.max(0, ...all.map((known) => known.slackMessages ?? 0));
      const merged = {
        ...newest,
        ...(project ? { project } : {}),
        ...(pullRequest ? { pullRequest } : {}),
        ...(url ? { url } : {}),
        ...(branch ? { branch } : {}),
        ...(Object.keys(lines).length > 0 ? { lines } : {}),
        ...(slackMessages > 0 ? { slackMessages } : {}),
        keys: [...new Set([...item.keys, ...matches.flatMap((known) => known.keys)])],
      };
      for (const match of matches) result.splice(result.indexOf(match), 1);
      result.push(merged);
    }
  }
  return result
    .sort((a, b) => b.at - a.at)
    .map(({ lines, ...item }) =>
      lines
        ? { ...item, sourceLines: Object.values(lines).reduce((sum, count) => sum + count, 0) }
        : item,
    );
}

function projectOf(thread: WorkThread | undefined) {
  return thread
    ? { project: { environmentId: thread.environmentId, projectId: thread.projectId } }
    : {};
}

/** Plans can be chosen before Slack and GitHub have been joined by the next sync. */
export function buildWorkPlan(
  items: ReadonlyArray<WorkItemMark>,
  groups: ReadonlyArray<WorkGroup>,
  ignored: ReadonlyArray<WorkItemMark>,
): WorkItemMark[] {
  const result: WorkItemMark[] = [];
  for (const item of items) {
    const group = groups.find((candidate) => workMatchesMarks(workItemKeys(candidate), [item]));
    const keys = group ? [...new Set([...item.keys, ...workItemKeys(group)])] : item.keys;
    if (workMatchesMarks(keys, ignored)) continue;
    const existing = result.findIndex((known) => workMatchesMarks(keys, [known]));
    if (existing < 0)
      result.push({ ...item, keys, title: group ? workGroupTitle(group) : item.title });
    else
      result[existing] = {
        ...result[existing]!,
        keys: [...new Set([...result[existing]!.keys, ...keys])],
      };
  }
  return result;
}

/** Groups waiting on someone else lately: a conversation or a PR, not a thread's own status. */
export function recapWaitingGroups(
  groups: ReadonlyArray<WorkGroup>,
  ignored: ReadonlyArray<WorkItemMark>,
  now: number,
): WorkGroup[] {
  return groups.filter(
    (group) =>
      group.status === "waiting" &&
      group.owner === null &&
      (group.conversation !== null ||
        group.pullRequest !== null ||
        group.pullRequests.length > 0) &&
      Date.parse(group.updatedAt) >= now - RECAP_WAITING_WINDOW_MS &&
      !workMatchesMarks(workItemKeys(group), ignored),
  );
}

const RECAP_WAITING_WINDOW_MS = 7 * 86_400_000;
