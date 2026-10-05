// @effect-diagnostics globalDate:off -- Snooze presets are local wall-clock times in the viewer's zone.
/**
 * Snoozing and pinning Work items. Marks match items by their stable keys, like ignored work,
 * so the page and the Work agent's tools hide and order the same items.
 *
 * @module workTriage
 */
import type { WorkItemMark, WorkSnoozedItem } from "@t3tools/contracts";

import { workMatchesMarks } from "./work.ts";

/** Snoozes still hiding their item at `now`. */
export function activeWorkSnoozes(
  snoozes: ReadonlyArray<WorkSnoozedItem>,
  now: number,
): WorkSnoozedItem[] {
  return snoozes.filter((snooze) => snooze.until > now);
}

/** When the next snoozed item returns, so a client can re-render once then instead of polling. */
export function nextWorkSnoozeExpiry(
  snoozes: ReadonlyArray<WorkSnoozedItem>,
  now: number,
): number | null {
  let next: number | null = null;
  for (const snooze of snoozes) {
    if (snooze.until > now && (next === null || snooze.until < next)) next = snooze.until;
  }
  return next;
}

/**
 * The snoozes to store after snoozing an item: expired entries and an earlier snooze of the same
 * item are dropped, so the list only grows with what is actually hidden.
 */
export function withWorkSnooze(
  snoozes: ReadonlyArray<WorkSnoozedItem>,
  snooze: WorkSnoozedItem,
  now: number,
): WorkSnoozedItem[] {
  return [...withoutWorkSnooze(snoozes, snooze.keys, now), snooze];
}

/** The snoozes to store after waking an item early, also dropping expired entries. */
export function withoutWorkSnooze(
  snoozes: ReadonlyArray<WorkSnoozedItem>,
  keys: ReadonlyArray<string>,
  now: number,
): WorkSnoozedItem[] {
  return activeWorkSnoozes(snoozes, now).filter((entry) => !workMatchesMarks(keys, [entry]));
}

/** Pinned items first, each part keeping its order. */
export function pinnedWorkFirst<Item>(
  items: ReadonlyArray<Item>,
  keysOf: (item: Item) => ReadonlyArray<string>,
  pins: ReadonlyArray<WorkItemMark>,
): Item[] {
  if (pins.length === 0) return [...items];
  const pinned: Item[] = [];
  const rest: Item[] = [];
  for (const item of items) (workMatchesMarks(keysOf(item), pins) ? pinned : rest).push(item);
  return [...pinned, ...rest];
}

export type WorkSnoozePresetId = "later" | "tomorrow" | "next-week";

export interface WorkSnoozePreset {
  readonly id: WorkSnoozePresetId;
  readonly label: string;
  /** Epoch ms the item returns. */
  readonly until: number;
}

const MORNING_HOUR = 9;

/** Local morning `days` calendar days after `now`; calendar math stays right across DST. */
function morningAfter(now: Date, days: number): Date {
  const next = new Date(now);
  next.setDate(next.getDate() + days);
  next.setHours(MORNING_HOUR, 0, 0, 0);
  return next;
}

/**
 * Later today (in three hours), tomorrow morning, and next Monday morning, in local time. On a
 * Sunday tomorrow is next Monday, so only one of them is offered.
 */
export function workSnoozePresets(now: Date): WorkSnoozePreset[] {
  const tomorrow = morningAfter(now, 1).getTime();
  const nextWeek = morningAfter(now, (1 - now.getDay() + 7) % 7 || 7).getTime();
  return [
    { id: "later", label: "Later today", until: now.getTime() + 3 * 60 * 60_000 },
    { id: "tomorrow", label: "Tomorrow", until: tomorrow },
    ...(nextWeek === tomorrow
      ? []
      : [{ id: "next-week" as const, label: "Next week", until: nextWeek }]),
  ];
}
