import {
  WorkCalendarError,
  type WorkCalendarReadInput,
  type WorkCalendarSetInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { workCalendarEvents } from "./workCalendarEvents.ts";

const isWorkCalendarError = Schema.is(WorkCalendarError);
const SECRET = "work-google-calendar-url";

const fetchCalendar = Effect.fn("WorkCalendar.fetch")(
  function* (url: string) {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(HttpClientRequest.get(url)).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      // The path contains the subscription credential; keep it out of HTTP trace spans.
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
    );
    if (response.status !== 200)
      return yield* new WorkCalendarError({
        message:
          "Google Calendar could not be read. Check the secret iCal address in Work settings.",
      });
    return yield* response.text;
  },
  Effect.timeout("20 seconds"),
  Effect.mapError(
    () =>
      new WorkCalendarError({
        message:
          "Google Calendar could not be read. Check the secret iCal address in Work settings.",
      }),
  ),
);

/** The private subscription address remains on the server and never enters server settings. */
export const setWorkCalendar = Effect.fn("WorkCalendar.set")(
  function* (input: WorkCalendarSetInput) {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    if (input.url === null) {
      yield* secrets.remove(SECRET);
      return;
    }
    const text = yield* fetchCalendar(input.url);
    if (!text.includes("BEGIN:VCALENDAR"))
      return yield* new WorkCalendarError({ message: "This address did not return a calendar." });
    yield* secrets.set(SECRET, new TextEncoder().encode(input.url));
  },
  Effect.mapError((error) =>
    isWorkCalendarError(error)
      ? error
      : new WorkCalendarError({ message: "Could not save the calendar connection." }),
  ),
);

export const readWorkCalendar = Effect.fn("WorkCalendar.read")(
  function* (input: WorkCalendarReadInput) {
    const from = DateTime.toDateUtc(DateTime.makeUnsafe(input.start));
    const to = DateTime.toDateUtc(DateTime.makeUnsafe(input.end));
    if (to.getTime() <= from.getTime() || to.getTime() - from.getTime() > 26 * 60 * 60_000)
      return yield* new WorkCalendarError({ message: "Choose a single calendar day." });
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const stored = yield* secrets.get(SECRET);
    if (Option.isNone(stored)) return { connected: false, events: [] };
    const text = yield* fetchCalendar(new TextDecoder().decode(stored.value));
    const events = yield* Effect.try({
      try: () => workCalendarEvents(text, from, to, input.date),
      catch: () => new WorkCalendarError({ message: "The calendar could not be parsed." }),
    });
    return { connected: true, events, syncedAt: DateTime.formatIso(yield* DateTime.now) };
  },
  Effect.mapError((error) =>
    isWorkCalendarError(error)
      ? error
      : new WorkCalendarError({ message: "Could not read the calendar connection." }),
  ),
);
