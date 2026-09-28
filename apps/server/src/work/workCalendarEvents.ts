import * as DateTime from "effect/DateTime";
import ical from "node-ical";
import type { WorkCalendarEvent } from "@t3tools/contracts";

/** Expand Google recurring events and exceptions before restricting to the requested day. */
export function workCalendarEvents(
  text: string,
  from: Date,
  to: Date,
  localDate: string,
): WorkCalendarEvent[] {
  if (!text.includes("BEGIN:VCALENDAR")) throw new Error("Invalid calendar");
  const parsed = ical.sync.parseICS(text);
  const events: WorkCalendarEvent[] = [];
  // Floating all-day dates belong to the user's day, regardless of the server timezone.
  const day = DateTime.makeZonedUnsafe(localDate, {
    timeZone: DateTime.zoneMakeLocal(),
    adjustForTimeZone: true,
  });
  const dayStart = DateTime.toDateUtc(day);
  const dayEnd = DateTime.toDateUtc(DateTime.add(day, { days: 1 }));
  const dateLabel = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  for (const event of Object.values(parsed)) {
    if (event?.type !== "VEVENT" || event.status === "CANCELLED") continue;
    const allDay = event.datetype === "date";
    const rangeStart = allDay ? dayStart : from;
    const rangeEnd = allDay ? dayEnd : to;
    for (const instance of ical.expandRecurringEvent(event, {
      from: rangeStart,
      to: rangeEnd,
      expandOngoing: true,
    })) {
      if (
        instance.event.status === "CANCELLED" ||
        instance.start >= rangeEnd ||
        instance.end <= rangeStart
      )
        continue;
      const title = typeof instance.summary === "string" ? instance.summary : instance.summary.val;
      const location = instance.event.location;
      events.push({
        id: `${event.uid}:${instance.start.toISOString()}`,
        title: title || "Untitled event",
        start: instance.isFullDay ? dateLabel(instance.start) : instance.start.toISOString(),
        end: instance.isFullDay ? dateLabel(instance.end) : instance.end.toISOString(),
        allDay: instance.isFullDay,
        ...(typeof location === "string" && location ? { location } : {}),
      });
    }
  }
  return events.sort((a, b) => a.start.localeCompare(b.start));
}
