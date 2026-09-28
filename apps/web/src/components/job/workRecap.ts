import type {
  EnvironmentId,
  ProjectId,
  SlackChannelKind,
  SlackState,
  SlackThread,
  ThreadPullRequestSnapshot,
  WorkItemMark,
} from "@t3tools/contracts";
import {
  legacyThreadPullRequestKey,
  threadPullRequestKeyOf,
} from "@t3tools/shared/threadPullRequests";
import {
  gitHubOwnerOf,
  slackWorkItemKeys,
  slackMessageSummary,
  workItemKeys,
  workItemTitle,
  workMatchesMarks,
  type WorkGroup,
  type WorkThread,
} from "./workGroups";

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
}

function channelOf(thread: SlackThread) {
  return { channel: { name: thread.channelName, kind: thread.channelKind } };
}

/** A thread or pull request names the work better than the Slack message that asked for it. */
function groupTitle(group: WorkGroup): string {
  return group.threads[0]?.title ?? group.pullRequests[0]?.snapshot?.title ?? workItemTitle(group);
}

export function localWorkDate(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * The standup covers everything since the start of the last workday, so Monday reports Friday
 * and the weekend. The demo covers this week since Monday, or all of last week on a Monday.
 */
export function workRecapWindows(now: Date) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = today.getDay();
  const lastWorkday = new Date(today);
  lastWorkday.setDate(today.getDate() - (day === 1 ? 3 : day === 0 ? 2 : 1));
  const week = new Date(today);
  week.setDate(today.getDate() - ((day + 6) % 7 || 7));
  return { today: today.getTime(), lastWorkday: lastWorkday.getTime(), week: week.getTime() };
}

/** Completion dates are evidence, never the last update or the age of a quiet conversation. */
export function buildWorkAccomplishments(input: {
  readonly groups: ReadonlyArray<WorkGroup>;
  readonly threads: ReadonlyArray<WorkThread>;
  readonly slack: SlackState | null;
  readonly ignored: ReadonlyArray<WorkItemMark>;
  readonly githubOwners: ReadonlyArray<string> | undefined;
  readonly since: number;
  readonly now: number;
}): WorkAccomplishment[] {
  const candidates: WorkAccomplishment[] = [];
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
        title: groupTitle(group),
        at: doneAt,
        evidence: "Marked done",
        groupId: group.id,
        source: "slack",
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
      thread.hasChanges === false &&
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
      ...(group ? { groupId: group.id } : {}),
      ...(link?.snapshot
        ? {
            pullRequest: {
              label: `${link.repository}#${link.number}`,
              state: link.snapshot.state,
              isDraft: link.snapshot.isDraft,
            },
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
    });
  }
  const result: WorkAccomplishment[] = [];
  for (const item of candidates.toSorted((a, b) => b.at - a.at)) {
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
      const merged = {
        ...newest,
        ...(project ? { project } : {}),
        ...(pullRequest ? { pullRequest } : {}),
        ...(url ? { url } : {}),
        keys: [...new Set([...item.keys, ...matches.flatMap((known) => known.keys)])],
      };
      for (const match of matches) result.splice(result.indexOf(match), 1);
      result.push(merged);
    }
  }
  return result.sort((a, b) => b.at - a.at);
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
    if (existing < 0) result.push({ ...item, keys, title: group ? groupTitle(group) : item.title });
    else
      result[existing] = {
        ...result[existing]!,
        keys: [...new Set([...result[existing]!.keys, ...keys])],
      };
  }
  return result;
}

/** The recap as plain lines for the text model: what the list shows, without the chrome. */
export function workRecapFacts(input: {
  readonly period: string;
  readonly sections: ReadonlyArray<readonly [string, ReadonlyArray<WorkAccomplishment>]>;
  readonly highlights: ReadonlyArray<WorkItemMark>;
  readonly planned: ReadonlyArray<string>;
  readonly meetings: ReadonlyArray<string>;
  readonly waiting: ReadonlyArray<string>;
}): string {
  const list = (title: string, lines: ReadonlyArray<string>) =>
    lines.length > 0 ? [title, ...lines.map((line) => `- ${line}`), ""] : [];
  return [
    `Period: ${input.period}`,
    "",
    ...input.sections.flatMap(([project, items]) =>
      list(
        `Done in ${project}:`,
        items.map(
          (item) =>
            `${item.title} (${item.evidence}${item.pullRequest ? `, ${item.pullRequest.label}` : ""})${
              workMatchesMarks(item.keys, input.highlights) ? " [highlighted by the user]" : ""
            }`,
        ),
      ),
    ),
    ...list("Planned today:", input.planned),
    ...list("Meetings today:", input.meetings),
    ...list("Waiting on others:", input.waiting),
  ]
    .join("\n")
    .trim();
}
