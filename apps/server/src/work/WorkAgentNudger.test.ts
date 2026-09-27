import { describe, expect, it } from "@effect/vitest";

import type { WorkItem } from "../mcp/toolkits/work/tools.ts";
import { newWorkItems, workAgentNudgeMessage } from "./WorkAgentNudger.ts";

const item = (id: string, reason: string): WorkItem => ({
  id,
  status: "needs",
  reason,
  updatedAt: "2026-09-27T12:00:00.000Z",
  conversation: {
    permalink: `https://acme.slack.com/archives/C1/p${id}`,
    channel: "app-bugs",
    author: "Bo",
    text: "refunds double-fire",
    followed: true,
  },
  devinSessions: [],
  t3Threads: [],
  pullRequests: [],
});

describe("WorkAgentNudger", () => {
  it("only sends what was not already there", () => {
    const current = [item("1", "Cy replied"), item("2", "Devin finished")];
    expect(newWorkItems(current, new Set(["1"])).map((entry) => entry.id)).toEqual(["2"]);
  });

  it("lists each new item with why and where, and keeps the agent's limits", () => {
    const message = workAgentNudgeMessage([item("2", "Devin finished")]);
    expect(message).toContain(
      "- Devin finished — #app-bugs · Bo: refunds double-fire (https://acme.slack.com/archives/C1/p2)",
    );
    expect(message).toContain("do not post in Slack");
  });
});
