import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  MessageId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  parseSlackThreadUrl,
  ProjectId,
  SLACK_FOLLOW_REACTION,
  type SlackState,
  type WorkItemMark,
  ThreadId,
} from "@t3tools/contracts";
import {
  buildWorkGroups,
  includedWorkProjects,
  openWorkMentions,
  slackMessageSummary,
  slackTsToMs,
  ungroupedWorkChannelThreads,
  workItemKeys,
  workMatchesMarks,
  slackWorkItemKeys,
  type WorkGroup,
  type WorkThread,
} from "@t3tools/shared/work";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as SlackService from "../../../slack/SlackService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  T3_THREAD_MESSAGE_CHARS,
  T3_THREAD_MESSAGE_LIMIT,
  WORK_OVERVIEW_LIMIT,
  WORK_TEXT_CHARS,
  type WorkItem,
  type WorkOverviewResult,
  type WorkStatusName,
  WorkToolFailedError,
  WorkToolkit,
} from "./tools.ts";

/** One server sees its own threads; the id only keys them. */
const LOCAL_ENVIRONMENT = EnvironmentId.make("local");

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

const fail = (message: string) => new WorkToolFailedError({ message });

/** Where a group stands for the agent: a conversation handed to someone else is watched. */
export function workStatusName(group: WorkGroup): WorkStatusName {
  return group.owner !== null && group.status !== "done" ? "watching" : group.status;
}

function workItemOf(group: WorkGroup, draftOf: (key: string) => string | undefined): WorkItem {
  const conversation = group.conversation;
  const draft = conversation ? draftOf(`${conversation.channelId}:${conversation.ts}`) : undefined;
  return {
    id: group.id,
    status: workStatusName(group),
    reason: group.reason,
    updatedAt: group.updatedAt,
    ...(conversation
      ? {
          conversation: {
            permalink: conversation.permalink,
            channel: conversation.channelName,
            author: conversation.authorName,
            text: cut(slackMessageSummary(conversation.markdown), WORK_TEXT_CHARS),
            ...(conversation.lastReply ? { lastReplyBy: conversation.lastReply.authorName } : {}),
            ...(group.owner ? { owner: group.owner.name } : {}),
            ...(group.waitingOn ? { waitingOn: group.waitingOn.name } : {}),
            ...(draft ? { draft } : {}),
            followed: conversation.followed === true,
          },
        }
      : {}),
    devinSessions: (conversation?.devin?.sessions ?? []).map((session) => ({
      url: session.url,
      ...(session.state ? { state: session.state } : {}),
      ...(session.title ? { title: session.title } : {}),
    })),
    t3Threads: group.threads.map((thread) => ({
      threadId: thread.id,
      title: thread.title,
      projectId: thread.projectId,
    })),
    pullRequests: [
      ...(group.pullRequest
        ? [
            {
              url: group.pullRequest.url,
              state: "open",
              title: group.pullRequest.title,
              ...(group.pullRequestRole ? { role: group.pullRequestRole } : {}),
              ...(group.pullRequest.author ? { author: group.pullRequest.author } : {}),
              ...(group.pullRequest.review ? { review: group.pullRequest.review } : {}),
              ...(group.pullRequest.checks ? { checks: group.pullRequest.checks } : {}),
            },
          ]
        : []),
      ...group.pullRequests.map((request) => ({
        url: request.url,
        ...(request.snapshot ? { state: request.snapshot.state } : {}),
      })),
      ...(conversation?.pullRequests ?? [])
        .filter((request) => !group.pullRequests.some((known) => known.url === request.url))
        .map((request) => ({
          url: request.url,
          ...(request.state ? { state: request.state } : {}),
        })),
    ],
  };
}

/**
 * The Work page's groups computed on the server: every Slack conversation that is yours, and
 * T3 work in the Work folders. Exported so it can be tested without the MCP layer.
 */
export function buildWorkOverview(input: {
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly slack: SlackState;
  readonly workProjectRootIds: ReadonlyArray<ProjectId> | undefined;
  readonly workGitHubOwners?: ReadonlyArray<string> | undefined;
  readonly workIgnoredItems?: ReadonlyArray<WorkItemMark> | undefined;
  readonly statuses: ReadonlyArray<WorkStatusName>;
  readonly includeNewThreads: boolean;
  readonly limit: number;
  readonly now: number;
}): WorkOverviewResult {
  const slackConnected = input.slack.connection.status === "connected";
  const threads: WorkThread[] = input.threads.map((thread) => ({
    ...thread,
    environmentId: LOCAL_ENVIRONMENT,
  }));
  const groups = buildWorkGroups(threads, {
    ...(slackConnected
      ? { conversations: input.slack.conversations, channelThreads: input.slack.threads }
      : {}),
    dismissed: input.slack.dismissed,
    owners: input.slack.conversationOwners,
    waits: input.slack.conversationWaits,
    github: {
      reviewRequests: input.slack.reviewRequests,
      authored: input.slack.authoredPullRequests,
      ...(input.slack.mergedPullRequests ? { merged: input.slack.mergedPullRequests } : {}),
      ...(input.workGitHubOwners ? { owners: input.workGitHubOwners } : {}),
    },
    now: input.now,
  });
  const projects = input.projects.map((project) => ({
    environmentId: LOCAL_ENVIRONMENT,
    id: project.id,
    title: project.title,
    workspaceRoot: project.workspaceRoot,
  }));
  const included = new Set(
    includedWorkProjects(
      projects,
      new Map([
        [
          LOCAL_ENVIRONMENT,
          {
            settings: {
              ...(input.workProjectRootIds ? { workProjectRootIds: input.workProjectRootIds } : {}),
            },
          },
        ],
      ]),
    ).map((project) => project.id),
  );
  const relevant = groups
    .filter((group) => !workMatchesMarks(workItemKeys(group), input.workIgnoredItems ?? []))
    .filter(
      (group) =>
        group.conversation !== null ||
        group.pullRequest !== null ||
        group.threads.some((thread) => included.has(thread.projectId)),
    );
  const counts = { needs: 0, working: 0, waiting: 0, watching: 0, done: 0 };
  for (const group of relevant) counts[workStatusName(group)] += 1;
  const wanted = new Set(input.statuses);
  const items = relevant
    .filter((group) => wanted.has(workStatusName(group)))
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, input.limit)
    .map((group) =>
      workItemOf(
        group,
        (key) =>
          input.slack.replyDrafts.find((draft) => `${draft.channelId}:${draft.ts}` === key)?.text,
      ),
    );
  const dismissed = new Set(
    input.slack.dismissed.map((thread) => `${thread.channelId}:${thread.ts}`),
  );
  const newThreads =
    input.includeNewThreads && slackConnected
      ? ungroupedWorkChannelThreads(input.slack.threads, groups)
          .filter((thread) => {
            const key = `${thread.channelId}:${thread.ts}`;
            return (
              !dismissed.has(key) &&
              !workMatchesMarks(slackWorkItemKeys(thread), input.workIgnoredItems ?? [])
            );
          })
          .slice(0, 20)
          .map((thread) => ({
            permalink: thread.permalink,
            channel: thread.channelName,
            author: thread.authorName,
            text: cut(slackMessageSummary(thread.markdown), WORK_TEXT_CHARS),
            replyCount: thread.replyCount,
          }))
      : [];
  const mentions = slackConnected
    ? openWorkMentions(input.slack.mentions, groups, {
        dismissed: input.slack.dismissed,
        ...(input.workIgnoredItems ? { ignored: input.workIgnoredItems } : {}),
      })
        .slice(0, 20)
        .map((mention) => ({
          permalink: mention.permalink,
          conversation: mention.thread.permalink,
          channel: mention.thread.channelName,
          author: mention.message.authorName,
          text: cut(mention.message.markdown, WORK_TEXT_CHARS),
          at: DateTime.formatIso(DateTime.makeUnsafe(slackTsToMs(mention.message.ts))),
        }))
    : [];
  return {
    slackConnected,
    counts,
    items,
    mentions,
    newThreads,
    projects: input.projects.map((project) => ({
      projectId: project.id,
      title: project.title,
      path: project.workspaceRoot,
    })),
  };
}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settings = yield* ServerSettings.ServerSettingsService;
  const slack = yield* SlackService.SlackService;
  const crypto = yield* Crypto.Crypto;

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  // Says how to get access, where the shared capability error only says it is missing.
  const requireWork = McpInvocationContext.requireMcpCapability("work").pipe(
    Effect.mapError(() =>
      fail(
        "This thread has no Work access. Every thread started on this version has it; start a new thread or restart this one's session.",
      ),
    ),
  );

  const callerThread = Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const thread = yield* snapshots
      .getThreadShellById(scope.threadId)
      .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationThreadShell>()));
    if (Option.isNone(thread)) return yield* fail("This thread was not found.");
    return thread.value;
  });

  /** A Slack link as the root message it belongs to. */
  const conversationRef = (permalink: string) => {
    const parsed = parseSlackThreadUrl(permalink);
    return parsed
      ? Effect.succeed({ channelId: parsed.channelId, ts: parsed.ts, url: parsed.url })
      : Effect.fail(fail("Pass a Slack message or thread link."));
  };

  /** The one workspace member a name picks out; the agent passes names, not ids. */
  const memberNamed = (name: string) =>
    Effect.gen(function* () {
      const members = yield* slack.listMembers.pipe(
        Effect.mapError((error) => fail(error.message)),
      );
      const wanted = name.trim().toLocaleLowerCase();
      const exact = members.filter((member) => member.name.toLocaleLowerCase() === wanted);
      const matches =
        exact.length > 0
          ? exact
          : members.filter((member) => member.name.toLocaleLowerCase().includes(wanted));
      if (matches.length === 1) return matches[0]!;
      return yield* fail(
        matches.length === 0
          ? `No workspace member is named "${name}".`
          : `"${name}" matches ${matches
              .slice(0, 8)
              .map((member) => member.name)
              .join(", ")}. Pass the full name.`,
      );
    });

  const slackError = Effect.mapError((error: { readonly message: string }) => fail(error.message));

  return WorkToolkit.of({
    work_overview: (input) =>
      Effect.gen(function* () {
        yield* requireWork;
        const shell = yield* snapshots
          .getShellSnapshot()
          .pipe(Effect.mapError(() => fail("Could not read T3 threads.")));
        const current = yield* settings.getSettings.pipe(
          Effect.mapError(() => fail("Could not read settings.")),
        );
        return buildWorkOverview({
          threads: shell.threads,
          projects: shell.projects,
          slack: yield* slack.current,
          workProjectRootIds: current.workProjectRootIds,
          workGitHubOwners: current.workGitHubOwners,
          workIgnoredItems: current.workIgnoredItems,
          statuses: input.statuses ?? ["needs", "working", "waiting", "watching"],
          includeNewThreads: input.includeNewThreads === true,
          limit: input.limit ?? WORK_OVERVIEW_LIMIT,
          now: DateTime.toEpochMillis(yield* DateTime.now),
        });
      }),

    read_slack_conversation: (input) =>
      Effect.gen(function* () {
        const ref = yield* conversationRef(input.permalink);
        const scope = yield* McpInvocationContext.McpInvocationContext;
        // A conversation linked to this thread is its own context; anything else is Work.
        if (!scope.capabilities.has("work")) {
          const thread = yield* callerThread;
          const linked = (thread.linkedSlackThreads ?? []).some(
            (link) => parseSlackThreadUrl(link)?.url === ref.url,
          );
          if (!linked) yield* requireWork;
        }
        const detail = yield* slack.getThread({ url: ref.url }).pipe(slackError);
        return {
          channel: detail.thread.channelName,
          permalink: detail.thread.permalink,
          messages: [detail.thread, ...detail.replies].map((message) => ({
            ts: message.ts,
            author: message.authorName,
            text: message.markdown,
          })),
          hasMore: detail.hasMore,
        };
      }),

    read_t3_thread: (input) =>
      Effect.gen(function* () {
        yield* requireWork;
        const thread = yield* snapshots
          .getThreadDetailById(ThreadId.make(input.threadId))
          .pipe(Effect.mapError(() => fail("Could not read the thread.")));
        if (Option.isNone(thread)) return yield* fail(`Thread ${input.threadId} was not found.`);
        const detail = thread.value;
        const limit = input.messageLimit ?? T3_THREAD_MESSAGE_LIMIT;
        return {
          threadId: detail.id,
          title: detail.title,
          projectId: detail.projectId,
          state: detail.archivedAt
            ? "archived"
            : (detail.latestTurn?.state ?? (detail.settledAt ? "settled" : "idle")),
          messages: detail.messages.slice(-limit).map((message) => ({
            role: message.role,
            text: cut(message.text, T3_THREAD_MESSAGE_CHARS),
            createdAt: message.createdAt,
          })),
          pullRequests: detail.pullRequests.map((request) => ({
            url: request.url,
            ...(request.snapshot ? { state: request.snapshot.state } : {}),
          })),
        };
      }),

    update_conversation: (input) =>
      Effect.gen(function* () {
        yield* requireWork;
        const ref = yield* conversationRef(input.permalink);
        const target = { channelId: ref.channelId, ts: ref.ts };
        const updated: string[] = [];
        if (input.followed === true) {
          yield* slack
            .setReaction({ ...target, name: SLACK_FOLLOW_REACTION, reacted: true })
            .pipe(slackError);
          updated.push("followed");
        } else if (input.followed === false) {
          yield* slack.unfollow(target).pipe(slackError);
          updated.push("unfollowed");
        }
        if (input.done !== undefined) {
          yield* slack.setDismissed({ ...target, dismissed: input.done }).pipe(slackError);
          updated.push(input.done ? "marked done" : "marked not done");
        }
        if (input.owner !== undefined) {
          const member = input.owner === null ? null : yield* memberNamed(input.owner);
          yield* slack.setConversationOwner({ ...target, owner: member }).pipe(slackError);
          updated.push(member ? `handed to ${member.name}` : "given back to the user");
        }
        if (input.waitingOn !== undefined) {
          const member = input.waitingOn === null ? null : yield* memberNamed(input.waitingOn);
          yield* slack.setConversationWait({ ...target, member }).pipe(slackError);
          updated.push(member ? `waiting on ${member.name}` : "no longer waiting");
        }
        return { updated };
      }),

    draft_slack_reply: (input) =>
      Effect.gen(function* () {
        yield* requireWork;
        const ref = yield* conversationRef(input.permalink);
        const text = input.text.trim();
        yield* slack
          .setReplyDraft({ channelId: ref.channelId, ts: ref.ts, text: text || null, by: "agent" })
          .pipe(slackError);
        return { saved: text.length > 0 };
      }),

    start_t3_thread: (input) =>
      Effect.gen(function* () {
        yield* requireWork;
        const caller = yield* callerThread;
        const project = yield* snapshots
          .getProjectShellById(ProjectId.make(input.projectId))
          .pipe(Effect.mapError(() => fail("Could not read the project.")));
        if (Option.isNone(project)) return yield* fail(`Project ${input.projectId} was not found.`);
        const link = input.slackPermalink ? parseSlackThreadUrl(input.slackPermalink) : null;
        if (input.slackPermalink && !link)
          return yield* fail("Pass a Slack message or thread link.");
        const threadId = ThreadId.make(yield* uuid);
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const title = cut(oneLine(input.title ?? input.prompt), 80);
        yield* engine
          .dispatch({
            type: "thread.create",
            commandId: CommandId.make(`mcp:work:thread-create:${threadId}`),
            threadId,
            projectId: project.value.id,
            title,
            modelSelection: caller.modelSelection,
            runtimeMode: caller.runtimeMode,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdAt,
            ...(link ? { linkedSlackThreads: [link.url] } : {}),
          })
          .pipe(Effect.mapError(() => fail("Could not create the thread.")));
        yield* engine
          .dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`mcp:work:turn-start:${threadId}`),
            threadId,
            message: {
              messageId: MessageId.make(yield* uuid),
              role: "user",
              text: input.prompt,
              attachments: [],
            },
            runtimeMode: caller.runtimeMode,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt,
          })
          .pipe(Effect.mapError(() => fail("Created the thread but could not start it.")));
        return { threadId };
      }),

    message_t3_thread: (input) =>
      Effect.gen(function* () {
        yield* requireWork;
        const caller = yield* callerThread;
        if (caller.id === input.threadId) {
          return yield* fail("That is this thread. Answer here instead.");
        }
        const target = yield* snapshots
          .getThreadShellById(ThreadId.make(input.threadId))
          .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationThreadShell>()));
        if (Option.isNone(target)) return yield* fail(`Thread ${input.threadId} was not found.`);
        yield* engine
          .dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`mcp:work:message:${yield* uuid}`),
            threadId: target.value.id,
            message: {
              messageId: MessageId.make(yield* uuid),
              role: "user",
              text: input.text,
              attachments: [],
            },
            runtimeMode: target.value.runtimeMode ?? DEFAULT_RUNTIME_MODE,
            interactionMode: target.value.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt: DateTime.formatIso(yield* DateTime.now),
          })
          .pipe(
            Effect.mapError(() =>
              fail(
                "The thread did not take the message. It may be busy; try again when it is idle.",
              ),
            ),
          );
        return { sent: true };
      }),
  });
});

export const WorkToolkitHandlersLive = WorkToolkit.toLayer(make);
