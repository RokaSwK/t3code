/**
 * One Slack Socket Mode connection: acknowledge each event at once, hand it on, and return
 * when Slack asks for a fresh connection. Opening the URL and reconnecting stay with the
 * caller, which owns the app-level token.
 *
 * @module SlackSocket
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Socket from "effect/unstable/socket/Socket";

import { parseSlackSocketFrame, SLACK_SOCKET_IDLE_MS, type SlackApiEvent } from "./slackEvents.ts";

const decoder = new TextDecoder();

/**
 * Runs until Slack sends `disconnect` (returning its reason) or the connection goes quiet for
 * {@link SLACK_SOCKET_IDLE_MS} (returning `idle`). A dropped connection fails with its error.
 */
export const runSlackSocket = Effect.fn("slack.socket")(function* (
  url: string,
  handlers: {
    readonly onHello: Effect.Effect<void>;
    readonly onEvent: (event: SlackApiEvent) => Effect.Effect<void>;
  },
) {
  const socket = yield* Socket.makeWebSocket(url, { openTimeout: "10 seconds" });
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const { pull } = yield* socket.reader;
      const writer = yield* socket.writer;
      for (;;) {
        const frames = yield* pull.pipe(Effect.timeoutOption(SLACK_SOCKET_IDLE_MS));
        if (Option.isNone(frames)) return "idle";
        for (const raw of frames.value) {
          const frame = parseSlackSocketFrame(typeof raw === "string" ? raw : decoder.decode(raw));
          if (!frame) continue;
          if (frame.type === "hello") yield* handlers.onHello;
          else if (frame.type === "disconnect") return frame.reason;
          else if (frame.type === "event") {
            yield* writer.write(frame.ack);
            if (frame.event) yield* handlers.onEvent(frame.event);
          }
        }
      }
    }),
  );
});
