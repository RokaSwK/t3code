import { describe, expect, it } from "@effect/vitest";

import { isAgentWorktreePath, parseAgentAppTitles } from "./AgentSessionSync.ts";

describe("parseAgentAppTitles", () => {
  it("reads the Codex app's thread names and the Claude app's Code session titles", () => {
    const titles = parseAgentAppTitles({
      codexIndex: [
        JSON.stringify({ id: "codex-1", thread_name: "  Locate  Tuyo Hardware project " }),
        "not json",
        JSON.stringify({ id: "codex-2" }),
      ].join("\n"),
      claudeSessions: [
        JSON.stringify({
          sessionId: "local_1",
          cliSessionId: "claude-1",
          title: "Gas station thing",
        }),
        JSON.stringify({ sessionId: "local_2", title: "No CLI session yet" }),
        "{",
      ],
    });
    expect([...titles]).toEqual([
      ["codex:codex-1", "Locate Tuyo Hardware project"],
      ["claudeAgent:claude-1", "Gas station thing"],
    ]);
  });
});

describe("isAgentWorktreePath", () => {
  it("leaves out the worktrees agents make for a task", () => {
    expect(isAgentWorktreePath("/Users/ada/app/.claude-worktrees/fix-login")).toBe(true);
    expect(isAgentWorktreePath("/Users/ada/app/.claude/worktrees/fix-login")).toBe(true);
    expect(isAgentWorktreePath("/Users/ada/.codex/worktrees/1a2b/app")).toBe(true);
    expect(isAgentWorktreePath("C:\\Users\\ada\\app\\.claude-worktrees\\fix")).toBe(true);
    expect(isAgentWorktreePath("/Users/ada/Documents/tuyoinc/support-dashboard")).toBe(false);
  });
});
