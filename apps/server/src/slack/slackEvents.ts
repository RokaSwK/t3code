/**
 * Pure rules for Slack's Socket Mode: reading its envelopes, and which conversation an event
 * touches. An event only says where something changed; the service reads that conversation
 * again rather than trusting the event's copy, so a missed or repeated event costs one read.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** With events live, polling only reconciles what events could have missed this often. */
export const SLACK_EVENTS_RECONCILE_MS = 15 * 60_000;
/** Events in a burst share one read. */
export const SLACK_EVENT_DEBOUNCE_MS = 3_000;
/** Search indexes a new message within seconds; a mention search waits this long after one. */
export const SLACK_EVENT_SEARCH_DELAY_MS = 10_000;
/** A connection silent this long is assumed dead and opened again. */
export const SLACK_SOCKET_IDLE_MS = 15 * 60_000;

/** The fields read from a message or reaction event. */
export interface SlackApiEvent {
  readonly type?: string;
  readonly subtype?: string;
  readonly channel?: string;
  readonly user?: string;
  readonly ts?: string;
  readonly thread_ts?: string;
  readonly text?: string;
  readonly reaction?: string;
  readonly item?: { readonly type?: string; readonly channel?: string; readonly ts?: string };
  /** The message after an edit (`message_changed`) or thread update (`message_replied`). */
  readonly message?: SlackApiEventMessage;
  /** The message before it was deleted (`message_deleted`). */
  readonly previous_message?: SlackApiEventMessage;
}

interface SlackApiEventMessage {
  readonly user?: string;
  readonly ts?: string;
  readonly thread_ts?: string;
  readonly text?: string;
}

const SlackEnvelope = Schema.Struct({
  type: Schema.String,
  envelope_id: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Struct({ event: Schema.optional(Schema.Unknown) })),
});
const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(SlackEnvelope));
const encodeAck = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ envelope_id: Schema.String })),
);

export type SlackSocketFrame =
  | { readonly type: "hello" }
  | {
      readonly type: "event";
      /** Send back right away, or Slack delivers the event again. */
      readonly ack: string;
      readonly event: SlackApiEvent | undefined;
    }
  | { readonly type: "disconnect"; readonly reason: string }
  | { readonly type: "other" };

/** One Socket Mode frame, or undefined when it is not JSON Slack would send. */
export function parseSlackSocketFrame(text: string): SlackSocketFrame | undefined {
  const envelope = Option.getOrUndefined(decodeEnvelope(text));
  if (!envelope) return undefined;
  switch (envelope.type) {
    case "hello":
      return { type: "hello" };
    case "disconnect":
      return { type: "disconnect", reason: envelope.reason ?? "unknown" };
    case "events_api": {
      if (!envelope.envelope_id) return undefined;
      const event = envelope.payload?.event;
      return {
        type: "event",
        ack: encodeAck({ envelope_id: envelope.envelope_id }),
        event: typeof event === "object" && event !== null ? (event as SlackApiEvent) : undefined,
      };
    }
    default:
      return { type: "other" };
  }
}

export type SlackEventTarget =
  | {
      readonly kind: "message";
      readonly channelId: string;
      /** The conversation root. */
      readonly ts: string;
      readonly reply: boolean;
      readonly userId?: string;
      readonly mentionsMe: boolean;
    }
  | {
      readonly kind: "reaction";
      readonly channelId: string;
      /** The message reacted to, root or reply. */
      readonly ts: string;
      readonly userId?: string;
      readonly reaction: string;
      readonly added: boolean;
    };

/** Where a message or reaction event happened, following edits and deletions to the message. */
export function slackEventTarget(event: SlackApiEvent, me: string): SlackEventTarget | undefined {
  if (event.type === "reaction_added" || event.type === "reaction_removed") {
    const item = event.item;
    if (item?.type !== "message" || !item.channel || !item.ts || !event.reaction) return undefined;
    return {
      kind: "reaction",
      channelId: item.channel,
      ts: item.ts,
      ...(event.user ? { userId: event.user } : {}),
      reaction: event.reaction,
      added: event.type === "reaction_added",
    };
  }
  if (event.type !== "message" || !event.channel) return undefined;
  const message =
    event.subtype === "message_changed" || event.subtype === "message_replied"
      ? event.message
      : event.subtype === "message_deleted"
        ? event.previous_message
        : event;
  if (!message?.ts) return undefined;
  const root = message.thread_ts ?? message.ts;
  return {
    kind: "message",
    channelId: event.channel,
    ts: root,
    reply: root !== message.ts,
    ...(message.user ? { userId: message.user } : {}),
    mentionsMe: (message.text ?? "").includes(`<@${me}>`),
  };
}

/** Errors that no retry fixes until the token or the app's settings change. */
export function slackSocketErrorIsFinal(error: string): boolean {
  return [
    "invalid_auth",
    "not_authed",
    "token_revoked",
    "account_inactive",
    "not_allowed_token_type",
    "link_disabled",
  ].includes(error);
}
