import type { WorkRecapItem, WorkRecapView } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import { buildSummaryPrompt } from "./WorkRecapPrompts.ts";

const item = (key: string, title: string, sourceLines?: number): WorkRecapItem => ({
  keys: [key],
  title,
  at: 0,
  evidence: "PR merged",
  source: "github",
  ...(sourceLines === undefined ? {} : { sourceLines }),
});

const feature = (id: string, title: string, area: string, items: ReadonlyArray<string>) => ({
  id,
  title,
  description: `${title}.`,
  area,
  minor: false,
  items,
});

const summaryPrompt = (view: WorkRecapView) =>
  buildSummaryPrompt({
    mode: "weekly",
    period: "this week",
    view,
    planned: [],
    meetings: [],
    waiting: [],
  });

it("lists areas and features biggest first, not by how many items they hold", () => {
  const { prompt, refs } = summaryPrompt({
    items: [
      item("a", "Copy fix", 4),
      item("b", "Label fix", 6),
      item("c", "Color fix", 2),
      item("d", "Card freezing", 1_400),
      item("e", "Refund emails", 300),
    ],
    features: [
      feature("f1", "Small fixes", "Web app", ["a", "b", "c"]),
      feature("f2", "Refund emails", "Support", ["e"]),
      feature("f3", "Card freezing", "Payments", ["d"]),
    ],
    unassigned: [],
    waitingTitles: [],
    summary: null,
    stale: false,
  });
  const order = ["Done in Payments", "Done in Support", "Done in Web app"].map((line) =>
    prompt.indexOf(line),
  );
  expect(order).toEqual(order.toSorted((a, b) => a - b));
  expect(prompt).toContain("- [F1] Card freezing (1 items, 1400 source lines)");
  // Short ids in list order map back to the features they name.
  expect([...refs]).toEqual([
    ["F1", { kind: "feature", id: "f3" }],
    ["F2", { kind: "feature", id: "f2" }],
    ["F3", { kind: "feature", id: "f1" }],
  ]);
});

it("gives work that is not grouped yet its own ids", () => {
  const { prompt, refs } = summaryPrompt({
    items: [item("a", "Copy fix"), item("b", "Card freezing", 900)],
    features: [],
    unassigned: ["a", "b"],
    waitingTitles: [],
    summary: null,
    stale: true,
  });
  expect(prompt).toContain("- [I1] Card freezing");
  expect(prompt).toContain("- [I2] Copy fix");
  expect(refs.get("I1")).toEqual({ kind: "item", id: "b" });
});
