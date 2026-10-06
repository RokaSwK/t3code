import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Socket from "effect/socket/Socket";

import type { SlackApiEvent } from "./slackEvents.ts";
import { runSlackSocket } from "./SlackSocket.ts";

type Listener = (event: Socket.WebSocketEvent) => void;

/** A WebSocket that opens at once, then delivers `frames` one per tick. */
function fakeSlack(frames: ReadonlyArray<string>) {
  const sent: string[] = [];
  const urls: string[] = [];
  const layer = Effect.provideService(Socket.WebSocketConstructor, (url) => {
    urls.push(url);
    const listeners = new Map<string, Set<Listener>>();
    const emit = (type: string, event: Socket.WebSocketEvent) => {
      for (const listener of listeners.get(type) ?? []) listener(event);
    };
    const ws: Socket.WebSocketLike & { readyState: number } = {
      readyState: 0,
      addEventListener: (type, listener) => {
        const set = listeners.get(type) ?? new Set();
        set.add(listener);
        listeners.set(type, set);
      },
      removeEventListener: (type, listener) => listeners.get(type)?.delete(listener),
      close: () => {
        ws.readyState = 3;
        emit("close", { code: 1000 });
      },
      send: (data) => {
        sent.push(String(data));
      },
    };
    // @effect-diagnostics-next-line globalTimers:off - a WebSocket opens on a later tick.
    setTimeout(() => {
      ws.readyState = 1;
      emit("open", {});
      frames.forEach((data, index) =>
        // @effect-diagnostics-next-line globalTimers:off - frames arrive on separate ticks.
        setTimeout(() => emit("message", { data }), index + 1),
      );
    }, 0);
    return ws;
  });
  return { sent, urls, layer };
}

describe("runSlackSocket", () => {
  it.effect("acknowledges each event, hands it on, and returns when Slack disconnects", () =>
    Effect.gen(function* () {
      const slack = fakeSlack([
        '{"type":"hello"}',
        '{"type":"events_api","envelope_id":"e1","payload":{"event":{"type":"message","channel":"C1","ts":"1.0"}}}',
        '{"type":"events_api","envelope_id":"e2","payload":{"event":{"type":"reaction_added","reaction":"eyes"}}}',
        '{"type":"disconnect","reason":"refresh_requested"}',
      ]);
      let hellos = 0;
      const events: SlackApiEvent[] = [];
      const reason = yield* runSlackSocket("wss://slack.test/link", {
        onHello: Effect.sync(() => {
          hellos += 1;
        }),
        onEvent: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
      }).pipe(slack.layer);
      assert.strictEqual(reason, "refresh_requested");
      assert.deepStrictEqual(slack.urls, ["wss://slack.test/link"]);
      assert.strictEqual(hellos, 1);
      assert.deepStrictEqual(slack.sent, ['{"envelope_id":"e1"}', '{"envelope_id":"e2"}']);
      assert.deepStrictEqual(
        events.map((event) => event.type),
        ["message", "reaction_added"],
      );
    }),
  );
});
