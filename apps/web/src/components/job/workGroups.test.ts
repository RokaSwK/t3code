import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ThreadPullRequestLink,
  type ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildWorkGroups, type WorkThread } from "./workGroups";

const now = "2026-09-26T20:00:00.000Z";

function thread(id: string, changes: Partial<WorkThread> = {}): WorkThread {
  return {
    environmentId: EnvironmentId.make("env-1"),
    id: ThreadId.make(id),
    projectId: ProjectId.make("project-1"),
    title: id,
    updatedAt: now,
    archivedAt: null,
    settledAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    latestTurn: null,
    backgroundLiveness: null,
    linkedSlackThreads: [],
    pullRequests: [],
    linkedPullRequest: null,
    branchPullRequest: null,
    ...changes,
  };
}

function snapshot(changes: Partial<ThreadPullRequestSnapshot> = {}): ThreadPullRequestSnapshot {
  return {
    state: "open",
    title: "Fix the issue",
    headBranch: "fix",
    baseBranch: "main",
    isDraft: false,
    updatedAt: now,
    syncedAt: now,
    ...changes,
  };
}

function pr(changes: Partial<ThreadPullRequestLink> = {}): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "owner/repo",
    number: 42,
    url: "https://github.com/owner/repo/pull/42",
    source: "manual",
    linkedAt: now,
    snapshot: snapshot(),
    stack: null,
    ...changes,
  };
}

describe("buildWorkGroups", () => {
  it("groups threads by shared PR and uses the latest synced status", () => {
    const groups = buildWorkGroups([
      thread("first", { pullRequests: [pr({ snapshot: snapshot({ checksState: "pending" }) })] }),
      thread("second", {
        environmentId: EnvironmentId.make("env-2"),
        backgroundLiveness: "working",
        pullRequests: [
          pr({
            snapshot: snapshot({
              checksState: "failing",
              syncedAt: "2026-09-26T20:01:00.000Z",
            }),
          }),
        ],
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.threads).toHaveLength(2);
    expect(groups[0]?.pullRequests).toHaveLength(1);
    expect(groups[0]?.pullRequests[0]?.threadRef.environmentId).toBe(EnvironmentId.make("env-2"));
    expect(groups[0]).toMatchObject({ status: "needs", reason: "PR checks failing" });
  });

  it("groups threads by a shared Slack conversation and prioritizes agent input", () => {
    const url = "https://example.slack.com/archives/C123/p1727380800000000";
    const groups = buildWorkGroups([
      thread("first", { linkedSlackThreads: [url] }),
      thread("second", { linkedSlackThreads: [url], hasPendingUserInput: true }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      slackLinks: [url],
      status: "needs",
      reason: "Agent needs an answer",
    });
  });

  it("shows pending PR checks as waiting and excludes tombstoned links", () => {
    const groups = buildWorkGroups([
      thread("waiting", { pullRequests: [pr({ snapshot: snapshot({ checksState: "pending" }) })] }),
      thread("hidden", {
        archivedAt: now,
        pullRequests: [pr({ source: "stack-dismissed" })],
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ status: "waiting", reason: "PR checks running" });
  });

  it("keeps settled linked work visible as done", () => {
    const groups = buildWorkGroups([
      thread("done", {
        archivedAt: now,
        settledAt: now,
        pullRequests: [pr({ snapshot: snapshot({ state: "merged" }) })],
      }),
    ]);

    expect(groups[0]).toMatchObject({ status: "done", reason: "Work completed" });
  });
});
