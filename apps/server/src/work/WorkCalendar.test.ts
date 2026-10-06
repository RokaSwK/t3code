import { WorkCalendarResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { readWorkCalendar, setWorkCalendar } from "./WorkCalendar.ts";
const encodeResult = Schema.encodeSync(Schema.fromJsonString(WorkCalendarResult));
const url = "https://calendar.google.com/calendar/ical/example/private-secret/basic.ics";
const range = {
  date: "2026-09-28",
  start: "2026-09-27T22:00:00.000Z",
  end: "2026-09-28T22:00:00.000Z",
};
const fixture =
  "BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:one\nDTSTART:20260928T080000Z\nDTEND:20260928T090000Z\nSUMMARY:Standup\nEND:VEVENT\nEND:VCALENDAR";
function dependencies(body = fixture, status = 200) {
  const store = new Map<string, Uint8Array>();
  return Layer.mergeAll(
    Layer.mock(ServerSecretStore.ServerSecretStore)({
      get: (name) => Effect.succeed(Option.fromNullishOr(store.get(name))),
      set: (name, value) => Effect.sync(() => void store.set(name, value)),
      remove: (name) => Effect.sync(() => void store.delete(name)),
    }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status }))),
      ),
    ),
  );
}
describe("WorkCalendar", () => {
  it.effect("connects read-only, returns events without the secret address, and disconnects", () =>
    Effect.gen(function* () {
      expect(yield* readWorkCalendar(range)).toEqual({ connected: false, events: [] });
      yield* setWorkCalendar({ url });
      const result = yield* readWorkCalendar(range);
      expect(result).toMatchObject({ connected: true, events: [{ title: "Standup" }] });
      expect(encodeResult(result)).not.toContain("private-secret");
      yield* setWorkCalendar({ url: null });
      expect(yield* readWorkCalendar(range)).toEqual({ connected: false, events: [] });
    }).pipe(Effect.provide(dependencies()), Effect.scoped),
  );
  it.effect("does not save invalid connections or leak their URL in errors", () =>
    Effect.gen(function* () {
      const error = yield* setWorkCalendar({ url }).pipe(Effect.flip);
      expect(error.message).not.toContain(url);
      expect(yield* readWorkCalendar(range)).toEqual({ connected: false, events: [] });
    }).pipe(Effect.provide(dependencies("Forbidden", 403)), Effect.scoped),
  );
});
