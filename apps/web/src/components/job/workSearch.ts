import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { SlackThread } from "@t3tools/contracts";

import type { WorkGroup } from "./workGroups";

type SearchProject = Pick<EnvironmentProject, "environmentId" | "id" | "title" | "workspaceRoot">;

function pullRequestText(request: { repository: string; number: number; url: string }) {
  return `${request.repository}#${request.number} ${request.url}`;
}

function slackThreadText(thread: SlackThread) {
  return [
    thread.markdown,
    `#${thread.channelName}`,
    thread.authorName,
    thread.lastReply?.authorName,
    thread.permalink,
    ...(thread.pullRequests ?? []).map(pullRequestText),
    ...(thread.devin?.sessions ?? []).flatMap((session) => [session.title, session.url]),
  ].join(" ");
}

/** Index the loaded work once, including items in collapsed sections and linked threads. */
export function buildWorkSearchIndex(
  groups: ReadonlyArray<WorkGroup>,
  threads: ReadonlyArray<SlackThread>,
  projects: ReadonlyArray<SearchProject>,
) {
  const projectText = new Map(
    projects.map((project) => [
      `${project.environmentId}:${project.id}`,
      `${project.title} ${project.workspaceRoot}`,
    ]),
  );
  return {
    groups: new Map(
      groups.map((group) => [
        group.id,
        [
          group.reason,
          group.owner?.name,
          group.waitingOn?.name,
          group.conversation ? slackThreadText(group.conversation) : "",
          ...group.threads.flatMap((thread) => [
            thread.title,
            projectText.get(`${thread.environmentId}:${thread.projectId}`),
          ]),
          ...group.pullRequests.flatMap((request) => [
            pullRequestText(request),
            request.snapshot?.title,
            request.snapshot?.headBranch,
          ]),
          ...(group.pullRequest
            ? [
                pullRequestText(group.pullRequest),
                group.pullRequest.title,
                group.pullRequest.author,
              ]
            : []),
        ]
          .join(" ")
          .toLocaleLowerCase(),
      ]),
    ),
    threads: new Map(
      threads.map((thread) => [
        `${thread.channelId}:${thread.ts}`,
        slackThreadText(thread).toLocaleLowerCase(),
      ]),
    ),
  };
}

/** All query words must match; their order and capitalization do not matter. */
export function workSearchMatches(text: string | undefined, query: string) {
  return query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .every((word) => (text ?? "").includes(word));
}
