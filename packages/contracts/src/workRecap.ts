import * as Schema from "effect/Schema";

export const WorkRecapSummaryInput = Schema.Struct({
  mode: Schema.Literals(["daily", "weekly"]),
  /** The recap's items as plain lines; the server only turns them into prose. */
  facts: Schema.String.check(Schema.isMaxLength(40_000)),
});
export type WorkRecapSummaryInput = typeof WorkRecapSummaryInput.Type;
export const WorkRecapSummaryResult = Schema.Struct({
  summary: Schema.String,
  /** The text generation model that wrote it. */
  model: Schema.String,
});
export type WorkRecapSummaryResult = typeof WorkRecapSummaryResult.Type;
export class WorkRecapSummaryError extends Schema.TaggedError<WorkRecapSummaryError>()(
  "WorkRecapSummaryError",
  { message: Schema.String },
) {}
