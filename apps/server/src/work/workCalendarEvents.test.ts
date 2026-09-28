import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { workCalendarEvents } from "./workCalendarEvents.ts";
const calendar = (...events: string[]) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.map((event) => `BEGIN:VEVENT\n${event}\nEND:VEVENT`).join("\n")}\r\nEND:VCALENDAR`;
const read = (
  text: string,
  date = "2026-09-28",
  start = "2026-09-27T22:00:00Z",
  end = "2026-09-28T22:00:00Z",
) =>
  workCalendarEvents(
    text,
    DateTime.toDateUtc(DateTime.makeUnsafe(start)),
    DateTime.toDateUtc(DateTime.makeUnsafe(end)),
    date,
  );

describe("work calendar events", () => {
  it("expands daily meetings, applies overrides and excludes deleted occurrences", () => {
    const text = calendar(
      "UID:daily\nDTSTART;TZID=Europe/Madrid:20260925T100000\nDTEND;TZID=Europe/Madrid:20260925T103000\nRRULE:FREQ=DAILY;COUNT=6\nEXDATE;TZID=Europe/Madrid:20260927T100000\nSUMMARY:Standup",
      "UID:daily\nRECURRENCE-ID;TZID=Europe/Madrid:20260928T100000\nDTSTART;TZID=Europe/Madrid:20260928T110000\nDTEND;TZID=Europe/Madrid:20260928T113000\nSUMMARY:Moved standup",
      "UID:cancelled\nDTSTART:20260928T080000Z\nDTEND:20260928T090000Z\nSTATUS:CANCELLED\nSUMMARY:Cancelled",
    );
    expect(read(text).map(({ title, start }) => ({ title, start }))).toEqual([
      { title: "Moved standup", start: "2026-09-28T09:00:00.000Z" },
    ]);
    expect(read(text, "2026-09-27", "2026-09-26T22:00:00Z", "2026-09-27T22:00:00Z")).toEqual([]);
  });
  it("handles recurring meetings across daylight saving time", () => {
    const text = calendar(
      "UID:dst\nDTSTART;TZID=Europe/Madrid:20261023T100000\nDTEND;TZID=Europe/Madrid:20261023T103000\nRRULE:FREQ=DAILY;COUNT=5\nSUMMARY:Standup",
    );
    expect(read(text, "2026-10-26", "2026-10-25T23:00:00Z", "2026-10-26T23:00:00Z")[0]?.start).toBe(
      "2026-10-26T09:00:00.000Z",
    );
  });
  it("keeps all-day dates in the user's day on either side of UTC", () => {
    const text = calendar(
      "UID:holiday\nDTSTART;VALUE=DATE:20260928\nDTEND;VALUE=DATE:20260929\nSUMMARY:Holiday",
    );
    expect(read(text, "2026-09-27", "2026-09-27T07:00:00Z", "2026-09-28T07:00:00Z")).toEqual([]);
    expect(read(text, "2026-09-28", "2026-09-28T07:00:00Z", "2026-09-29T07:00:00Z")).toMatchObject([
      { start: "2026-09-28", end: "2026-09-29", allDay: true },
    ]);
    expect(read(text)).toHaveLength(1);
  });
  it("includes ongoing events and excludes events ending at midnight or starting tomorrow", () => {
    const text = calendar(
      "UID:ongoing\nDTSTART:20260927T210000Z\nDTEND:20260928T010000Z\nSUMMARY:Ongoing",
      "UID:ended\nDTSTART:20260927T210000Z\nDTEND:20260927T220000Z\nSUMMARY:Ended",
      "UID:tomorrow\nDTSTART:20260928T220000Z\nDTEND:20260928T230000Z\nSUMMARY:Tomorrow",
    );
    expect(read(text).map((event) => event.title)).toEqual(["Ongoing"]);
  });
});
