import * as Schema from "effect/Schema";
import { IsoDateTime } from "./baseSchemas.ts";

export const WorkCalendarReadInput = Schema.Struct({
  start: IsoDateTime,
  end: IsoDateTime,
  date: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
});
export type WorkCalendarReadInput = typeof WorkCalendarReadInput.Type;
export const WorkCalendarSetInput = Schema.Struct({
  url: Schema.NullOr(
    Schema.String.check(
      Schema.isMaxLength(4096),
      Schema.isPattern(/^https:\/\/calendar\.google\.com\/calendar\/ical\/[^\s]+\/basic\.ics$/),
    ),
  ),
});
export type WorkCalendarSetInput = typeof WorkCalendarSetInput.Type;
export const WorkCalendarEvent = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  start: Schema.String,
  end: Schema.String,
  allDay: Schema.Boolean,
  location: Schema.optional(Schema.String),
});
export type WorkCalendarEvent = typeof WorkCalendarEvent.Type;
export const WorkCalendarResult = Schema.Struct({
  connected: Schema.Boolean,
  events: Schema.Array(WorkCalendarEvent),
  syncedAt: Schema.optional(IsoDateTime),
});
export type WorkCalendarResult = typeof WorkCalendarResult.Type;
export class WorkCalendarError extends Schema.TaggedError<WorkCalendarError>()(
  "WorkCalendarError",
  { message: Schema.String },
) {}
