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
  }).prompt;

it("lists areas and features biggest first, not by how many items they hold", () => {
  const prompt = summaryPrompt({
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
  expect(prompt).toContain("Card freezing (1 items, 1400 source lines)");
});
