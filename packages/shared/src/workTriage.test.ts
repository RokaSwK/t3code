// @effect-diagnostics globalDate:off -- Local dates keep preset assertions independent of the machine's zone.
import { describe, expect, it } from "vite-plus/test";

import {
  activeWorkSnoozes,
  nextWorkSnoozeExpiry,
  pinnedWorkFirst,
  withWorkSnooze,
  withoutWorkSnooze,
  workSnoozePresets,
} from "./workTriage.ts";

const NOW = 1_800_000_000_000;
const snooze = (key: string, until: number, at = NOW - 1) => ({
  keys: [key],
  title: key,
  at,
  until,
});

describe("work snoozes", () => {
  it("hides an item until its snooze passes", () => {
    const snoozes = [snooze("a", NOW + 1), snooze("b", NOW), snooze("c", NOW - 5)];
    expect(activeWorkSnoozes(snoozes, NOW).map((entry) => entry.title)).toEqual(["a"]);
  });

  it("finds the soonest return still ahead", () => {
    const snoozes = [snooze("a", NOW + 500), snooze("b", NOW + 100), snooze("c", NOW - 5)];
    expect(nextWorkSnoozeExpiry(snoozes, NOW)).toBe(NOW + 100);
    expect(nextWorkSnoozeExpiry([snooze("c", NOW - 5)], NOW)).toBeNull();
  });

  it("replaces an earlier snooze of the same item and prunes expired ones on write", () => {
    const stored = [snooze("a", NOW + 100), snooze("old", NOW - 1), snooze("b", NOW + 200)];
    const next = withWorkSnooze(stored, { ...snooze("a", NOW + 900), keys: ["x", "a"] }, NOW);
    expect(next.map((entry) => [entry.title, entry.until])).toEqual([
      ["b", NOW + 200],
      ["a", NOW + 900],
    ]);
  });

  it("wakes an item early by any of its keys", () => {
    const stored = [snooze("a", NOW + 100), snooze("old", NOW - 1), snooze("b", NOW + 200)];
    expect(withoutWorkSnooze(stored, ["z", "a"], NOW).map((entry) => entry.title)).toEqual(["b"]);
  });
});

describe("pinnedWorkFirst", () => {
  it("moves pinned items to the top and keeps each part's order", () => {
    const items = [["a"], ["b"], ["c"], ["d"]];
    const pins = [
      { keys: ["d"], title: "d", at: 1 },
      { keys: ["b"], title: "b", at: 2 },
    ];
    expect(pinnedWorkFirst(items, (item) => item, pins)).toEqual([["b"], ["d"], ["a"], ["c"]]);
    expect(pinnedWorkFirst(items, (item) => item, [])).toEqual(items);
  });
});

describe("workSnoozePresets", () => {
  const local = (year: number, month: number, day: number, hour: number, minute = 0) =>
    new Date(year, month - 1, day, hour, minute);

  it("offers later today, tomorrow morning, and next Monday morning in local time", () => {
    // 2026-10-07 is a Wednesday.
    const now = local(2026, 10, 7, 14, 30);
    expect(workSnoozePresets(now).map((preset) => [preset.id, preset.until])).toEqual([
      ["later", now.getTime() + 3 * 60 * 60_000],
      ["tomorrow", local(2026, 10, 8, 9).getTime()],
      ["next-week", local(2026, 10, 12, 9).getTime()],
    ]);
  });

  it("goes to the following Monday from a Monday", () => {
    const presets = workSnoozePresets(local(2026, 10, 5, 8));
    expect(presets.find((preset) => preset.id === "next-week")?.until).toBe(
      local(2026, 10, 12, 9).getTime(),
    );
  });

  it("offers only tomorrow on a Sunday, when it is also next Monday", () => {
    const presets = workSnoozePresets(local(2026, 10, 11, 20));
    expect(presets.map((preset) => preset.id)).toEqual(["later", "tomorrow"]);
    expect(presets[1]?.until).toBe(local(2026, 10, 12, 9).getTime());
  });
});
