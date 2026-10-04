/**
 * Work tools - what the Work page shows and does, for any agent thread.
 *
 * The agent reads the same groups the page shows (see `@t3tools/shared/work`), reads Slack
 * conversations and T3 threads in full, and acts through the same services the page uses, so
 * everything it does appears live on every client. Reading a Slack conversation linked to the
 * calling thread needs no Work access; everything else does.
 *
 * @module mcp/toolkits/work/tools
 */
import {
  McpCapabilityUnavailableError,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as SlackService from "../../../slack/SlackService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  ServerSettings.ServerSettingsService,
  SlackService.SlackService,
];

const WORK_ACCESS = "Every thread has Work access.";

export class WorkToolFailedError extends Schema.TaggedError<WorkToolFailedError>()(
  "WorkToolFailedError",
  { message: Schema.String },
) {}

export const WorkToolError = Schema.Union([McpCapabilityUnavailableError, WorkToolFailedError]);
export type WorkToolError = typeof WorkToolError.Type;

export const WorkStatusName = Schema.Literals(["needs", "working", "waiting", "watching", "done"]);
export type WorkStatusName = typeof WorkStatusName.Type;

const WorkItem = Schema.Struct({
  id: Schema.String,
  status: WorkStatusName,
  reason: Schema.String,
  updatedAt: Schema.String,
  conversation: Schema.optional(
    Schema.Struct({
      permalink: Schema.String,
      channel: Schema.String,
      author: Schema.String,
      text: Schema.String,
      lastReplyBy: Schema.optional(Schema.String),
      owner: Schema.optional(Schema.String),
      waitingOn: Schema.optional(Schema.String),
      /** A reply saved to send; the user sends it. */
      draft: Schema.optional(Schema.String),
      followed: Schema.Boolean,
    }),
  ),
  devinSessions: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      state: Schema.optional(Schema.String),
      title: Schema.optional(Schema.String),
    }),
  ),
  t3Threads: Schema.Array(
    Schema.Struct({ threadId: Schema.String, title: Schema.String, projectId: Schema.String }),
  ),
  pullRequests: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      state: Schema.optional(Schema.String),
      title: Schema.optional(Schema.String),
      /** "review" when it waits for the user's review, "authored" when it is theirs. */
      role: Schema.optional(Schema.String),
      author: Schema.optional(Schema.String),
      review: Schema.optional(Schema.String),
      checks: Schema.optional(Schema.String),
    }),
  ),
});
export type WorkItem = typeof WorkItem.Type;

export const WorkOverviewResult = Schema.Struct({
  slackConnected: Schema.Boolean,
  counts: Schema.Struct({
    needs: NonNegativeInt,
    working: NonNegativeInt,
    waiting: NonNegativeInt,
    watching: NonNegativeInt,
    done: NonNegativeInt,
  }),
  items: Schema.Array(WorkItem),
  /** Messages that tag the user, outside the items above, that they have not answered. */
  mentions: Schema.Array(
    Schema.Struct({
      permalink: Schema.String,
      conversation: Schema.String,
      channel: Schema.String,
      author: Schema.String,
      text: Schema.String,
      at: Schema.String,
    }),
  ),
  newThreads: Schema.Array(
    Schema.Struct({
      permalink: Schema.String,
      channel: Schema.String,
      author: Schema.String,
      text: Schema.String,
      replyCount: NonNegativeInt,
    }),
  ),
  projects: Schema.Array(
    Schema.Struct({
      projectId: Schema.String,
      title: Schema.String,
      path: Schema.String,
    }),
  ),
});
export type WorkOverviewResult = typeof WorkOverviewResult.Type;

const WorkOverviewTool = Tool.make("work_overview", {
  description: `The user's work as the Work page shows it: their Slack conversations (followed with 👀, Devin threads they are in, handed to others) and GitHub pull requests waiting for their review or theirs, grouped needs / working / waiting / watching / done with the reason, mentions of the user they have not answered (reply in the conversation link, or mark it done), plus the T3 threads, Devin sessions, and pull requests on each, T3 work in their folders, and the projects you can start threads in. Start triage here. ${WORK_ACCESS}`,
  parameters: Schema.Struct({
    statuses: Schema.optional(
      Schema.Array(WorkStatusName).annotate({
        description: "Which groups to list. Defaults to everything except done.",
      }),
    ),
    includeNewThreads: Schema.optional(
      Schema.Boolean.annotate({
        description: "Also list new threads from the user's channels that are not theirs yet.",
      }),
    ),
    limit: Schema.optional(
      PositiveInt.annotate({ description: "Most items to return, newest first. Default 40." }),
    ),
  }),
  success: WorkOverviewResult,
  failure: WorkToolError,
  dependencies,
})
  .annotate(Tool.Title, "Work overview")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SlackPermalink = TrimmedNonEmptyString.annotate({
  description: "A Slack message or thread link, as work_overview returns it.",
});

export const SlackConversationResult = Schema.Struct({
  channel: Schema.String,
  permalink: Schema.String,
  messages: Schema.Array(
    Schema.Struct({ ts: Schema.String, author: Schema.String, text: Schema.String }),
  ),
  hasMore: Schema.Boolean,
});
export type SlackConversationResult = typeof SlackConversationResult.Type;

const ReadSlackConversationTool = Tool.make("read_slack_conversation", {
  description:
    "Read a Slack conversation in full: its first message and replies (up to 200). Works for any conversation linked to this thread; other conversations need Work access.",
  parameters: Schema.Struct({ permalink: SlackPermalink }),
  success: SlackConversationResult,
  failure: WorkToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read Slack conversation")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const T3ThreadResult = Schema.Struct({
  threadId: Schema.String,
  title: Schema.String,
  projectId: Schema.String,
  state: Schema.String,
  messages: Schema.Array(
    Schema.Struct({ role: Schema.String, text: Schema.String, createdAt: Schema.String }),
  ),
  pullRequests: Schema.Array(
    Schema.Struct({ url: Schema.String, state: Schema.optional(Schema.String) }),
  ),
});
export type T3ThreadResult = typeof T3ThreadResult.Type;

const ReadT3ThreadTool = Tool.make("read_t3_thread", {
  description: `Read another T3 thread: its state and its latest messages. ${WORK_ACCESS}`,
  parameters: Schema.Struct({
    threadId: TrimmedNonEmptyString,
    messageLimit: Schema.optional(
      PositiveInt.annotate({ description: "Latest messages to return. Default 20." }),
    ),
  }),
  success: T3ThreadResult,
  failure: WorkToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read T3 thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const UpdateConversationTool = Tool.make("update_conversation", {
  description: `Change where a Slack conversation stands on the Work page, only in the user's own view: follow or unfollow it (their 👀), mark it done or not, hand it to a workspace member or back to the user, or mark it as waiting on someone. ${WORK_ACCESS}`,
  parameters: Schema.Struct({
    permalink: SlackPermalink,
    followed: Schema.optional(Schema.Boolean),
    done: Schema.optional(Schema.Boolean),
    owner: Schema.optional(
      Schema.NullOr(TrimmedNonEmptyString).annotate({
        description:
          "A workspace member's name to hand it to, or null to give it back to the user.",
      }),
    ),
    waitingOn: Schema.optional(
      Schema.NullOr(TrimmedNonEmptyString).annotate({
        description:
          "A workspace member's name the user is waiting on, such as a reviewer, or null to clear it.",
      }),
    ),
  }),
  success: Schema.Struct({ updated: Schema.Array(Schema.String) }),
  failure: WorkToolError,
  dependencies,
})
  .annotate(Tool.Title, "Update Slack conversation")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const DraftSlackReplyTool = Tool.make("draft_slack_reply", {
  description: `Save a reply for the user to review and send in a Slack conversation. It is not posted: the user edits and sends it from the Work page. Replaces an earlier draft; pass an empty text to clear it. ${WORK_ACCESS}`,
  parameters: Schema.Struct({
    permalink: SlackPermalink,
    text: Schema.String.annotate({ description: "Slack mrkdwn. Empty clears the draft." }),
  }),
  success: Schema.Struct({ saved: Schema.Boolean }),
  failure: WorkToolError,
  dependencies,
})
  .annotate(Tool.Title, "Draft Slack reply")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const StartT3ThreadTool = Tool.make("start_t3_thread", {
  description: `Start a new T3 thread in a project with a first message, to hand a task to another agent. It uses this thread's model, and can be linked to the Slack conversation it is about. Say what you started to the user. ${WORK_ACCESS}`,
  parameters: Schema.Struct({
    projectId: TrimmedNonEmptyString.annotate({ description: "From work_overview's projects." }),
    prompt: TrimmedNonEmptyString,
    title: Schema.optional(TrimmedNonEmptyString),
    slackPermalink: Schema.optional(SlackPermalink),
  }),
  success: Schema.Struct({ threadId: Schema.String }),
  failure: WorkToolError,
  dependencies,
})
  .annotate(Tool.Title, "Start T3 thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const MessageT3ThreadTool = Tool.make("message_t3_thread", {
  description: `Send a message to another T3 thread's agent, starting its next turn: answer its question, redirect it, or ask for status. ${WORK_ACCESS}`,
  parameters: Schema.Struct({ threadId: TrimmedNonEmptyString, text: TrimmedNonEmptyString }),
  success: Schema.Struct({ sent: Schema.Boolean }),
  failure: WorkToolError,
  dependencies,
})
  .annotate(Tool.Title, "Message T3 thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const WorkToolkit = Toolkit.make(
  WorkOverviewTool,
  ReadSlackConversationTool,
  ReadT3ThreadTool,
  UpdateConversationTool,
  DraftSlackReplyTool,
  StartT3ThreadTool,
  MessageT3ThreadTool,
);

/** Most messages read_t3_thread returns, and the longest text per message. */
export const T3_THREAD_MESSAGE_LIMIT = 20;
export const T3_THREAD_MESSAGE_CHARS = 4_000;
export const WORK_OVERVIEW_LIMIT = 40;
export const WORK_TEXT_CHARS = 300;
