import * as Schema from "effect/Schema";
import { IsoDateTime } from "./baseSchemas.ts";
import { PullRequestState } from "./pullRequest.ts";
import { SlackChannelKind } from "./slack.ts";

/**
 * The window a recap covers. The client picks it because only the client knows its timezone;
 * the server groups and summarizes the finished work inside it.
 */
export const WorkRecapInput = Schema.Struct({
  mode: Schema.Literals(["daily", "weekly"]),
  /** Ms since the epoch: work finished at or after `since` and before `until` counts. */
  since: Schema.Number,
  until: Schema.Number,
  /** How the client names the window ("since Friday"); only used in the summary prompt. */
  period: Schema.String.check(Schema.isMaxLength(64)),
  /** The client's local date and day bounds, for today's plan and calendar. */
  date: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
  dayStart: IsoDateTime,
  dayEnd: IsoDateTime,
  /** Today's meetings as the client's calendar shows them ("10:00 Standup"). */
  meetings: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMaxLength(200))).check(Schema.isMaxLength(30)),
  ),
  /**
   * Without it the server only reads what it already has. With it the server groups new work
   * and writes a missing summary, which takes the text generation model tens of seconds.
   */
  write: Schema.Boolean,
  /** Throw away this window's grouping and group it again from scratch. */
  regroup: Schema.optional(Schema.Boolean),
});
export type WorkRecapInput = typeof WorkRecapInput.Type;

/** One piece of finished work: a merged PR, a thread that changed files, or a conversation. */
export const WorkRecapItem = Schema.Struct({
  /** Every key the item is known by (PR, thread, Slack); the first is its id in this view. */
  keys: Schema.Array(Schema.String),
  title: Schema.String,
  at: Schema.Number,
  evidence: Schema.Literals(["Marked done", "PR merged", "Thread settled"]),
  source: Schema.Literals(["slack", "github", "t3"]),
  url: Schema.optional(Schema.String),
  /** The Work group to open when the item is clicked. */
  groupId: Schema.optional(Schema.String),
  projectTitle: Schema.optional(Schema.String),
  channel: Schema.optional(Schema.Struct({ name: Schema.String, kind: SlackChannelKind })),
  pullRequest: Schema.optional(
    Schema.Struct({ label: Schema.String, state: PullRequestState, isDraft: Schema.Boolean }),
  ),
  branch: Schema.optional(Schema.String),
  /** How big the work was, for ranking: its PRs' source lines and its conversation's replies. */
  sourceLines: Schema.optional(Schema.Number),
  slackMessages: Schema.optional(Schema.Number),
});
export type WorkRecapItem = typeof WorkRecapItem.Type;

/** A feature the model named once; finished work is assigned to it and stays there. */
export const WorkRecapFeature = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  /** The broad area (Support, Mobile, …) features are shown under. */
  area: Schema.String,
  /** Chores and trivia, folded together at the end and left out of the summary. */
  minor: Schema.Boolean,
  /** First keys of this view's items in the feature. */
  items: Schema.Array(Schema.String),
});
export type WorkRecapFeature = typeof WorkRecapFeature.Type;

export const WorkRecapView = Schema.Struct({
  items: Schema.Array(WorkRecapItem),
  features: Schema.Array(WorkRecapFeature),
  /** First keys of items no feature holds yet. */
  unassigned: Schema.Array(Schema.String),
  /** Short names for Work groups that wait on someone, by group id. */
  waitingTitles: Schema.Array(Schema.Struct({ groupId: Schema.String, title: Schema.String })),
  summary: Schema.NullOr(Schema.Struct({ text: Schema.String, model: Schema.String })),
  /** Something is missing that a write would fill in: new work, a summary, or a title. */
  stale: Schema.Boolean,
});
export type WorkRecapView = typeof WorkRecapView.Type;

export class WorkRecapError extends Schema.TaggedError<WorkRecapError>()("WorkRecapError", {
  message: Schema.String,
}) {}
