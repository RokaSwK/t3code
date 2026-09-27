import * as Schema from "effect/Schema";

import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Revyl cloud devices, driven through the `revyl` CLI signed in on the server. The client plays
 * a session's WebRTC stream straight from Revyl and sends input through the server.
 */
export const RevylPlatform = Schema.Literals(["ios", "android"]);
export type RevylPlatform = typeof RevylPlatform.Type;

export const RevylSession = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  platform: RevylPlatform,
  /** Revyl's own viewer for the session. */
  viewerUrl: Schema.String,
  /** WHEP endpoint for the live screen; absent while the device is still starting. */
  whepUrl: Schema.optional(Schema.String),
  /** Screen size in the points taps and swipes are given in. */
  screenWidth: PositiveInt,
  screenHeight: PositiveInt,
  startedAt: Schema.String,
});
export type RevylSession = typeof RevylSession.Type;

export const RevylState = Schema.Union([
  Schema.TaggedStruct("unavailable", { reason: Schema.String }),
  Schema.TaggedStruct("signedOut", {}),
  Schema.TaggedStruct("ready", {
    email: Schema.optional(Schema.String),
    sessions: Schema.Array(RevylSession),
  }),
]);
export type RevylState = typeof RevylState.Type;

export const RevylStartInput = Schema.Struct({ platform: RevylPlatform });
export type RevylStartInput = typeof RevylStartInput.Type;

export const RevylStopInput = Schema.Struct({ sessionId: TrimmedNonEmptyString });
export type RevylStopInput = typeof RevylStopInput.Type;

const Point = { x: Schema.Int, y: Schema.Int };

export const RevylInput = Schema.Union([
  Schema.TaggedStruct("tap", Point),
  Schema.TaggedStruct("longPress", Point),
  /** Swipe starting at the point; `up` moves the finger up, scrolling content down. */
  Schema.TaggedStruct("swipe", {
    ...Point,
    direction: Schema.Literals(["up", "down", "left", "right"]),
  }),
  Schema.TaggedStruct("type", { text: Schema.String.check(Schema.isNonEmpty()) }),
  Schema.TaggedStruct("key", { key: Schema.Literals(["ENTER", "BACKSPACE"]) }),
  Schema.TaggedStruct("home", {}),
  Schema.TaggedStruct("back", {}),
  Schema.TaggedStruct("navigate", { url: TrimmedNonEmptyString }),
]);
export type RevylInput = typeof RevylInput.Type;

export const RevylInputRequest = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  input: RevylInput,
});
export type RevylInputRequest = typeof RevylInputRequest.Type;

export class RevylError extends Schema.TaggedError<RevylError>()("RevylError", {
  message: Schema.String,
}) {}
