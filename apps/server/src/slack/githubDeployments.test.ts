import type { WorkGitHubPullRequest } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  type BranchCommit,
  deploymentOf,
  deploymentsToCheck,
  parseGitHubDeployments,
  withDeployments,
} from "./githubDeployments.ts";

const NOW = Date.parse("2026-10-04T12:00:00Z");
const MERGED_AT = "2026-10-04T10:00:00Z";
const merge = { base: "master", oid: "merge" };
const commit = (oid: string, committedDate: string, signals: BranchCommit["signals"] = []) => ({
  oid,
  committedDate,
  signals,
});
const request = (number: number, overrides: Partial<WorkGitHubPullRequest> = {}) => ({
  url: `https://github.com/acme/api/pull/${number}`,
  repository: "acme/api",
  number,
  title: `PR ${number}`,
  isDraft: false,
  updatedAt: MERGED_AT,
  mergedAt: MERGED_AT,
  ...overrides,
});

describe("deploymentOf", () => {
  it("is deployed once the merge commit or any later commit deployed", () => {
    expect(
      deploymentOf({ mergedAt: MERGED_AT }, merge, [
        commit("later", "2026-10-04T11:00:00Z", ["deployed"]),
        commit("merge", MERGED_AT, ["skipped"]),
      ]),
    ).toBe("deployed");
    expect(
      deploymentOf({ mergedAt: MERGED_AT }, merge, [
        commit("merge", MERGED_AT, ["pending"]),
        commit("older", "2026-10-03T10:00:00Z", ["deployed"]),
      ]),
    ).toBe("pending");
  });

  it("reports a failed deploy unless a retry is still running", () => {
    const failed = commit("merge", MERGED_AT, ["failed"]);
    expect(deploymentOf({ mergedAt: MERGED_AT }, merge, [failed])).toBe("failed");
    expect(
      deploymentOf({ mergedAt: MERGED_AT }, merge, [
        commit("later", "2026-10-04T11:00:00Z", ["pending"]),
        failed,
      ]),
    ).toBe("pending");
  });

  it("counts every commit read as later when the merge commit is older than them", () => {
    expect(
      deploymentOf({ mergedAt: "2026-09-01T00:00:00Z" }, merge, [
        commit("a", "2026-10-04T11:00:00Z", ["deployed"]),
      ]),
    ).toBe("deployed");
  });

  it("is unknown on a branch that never shows a deploy", () => {
    expect(
      deploymentOf({ mergedAt: MERGED_AT }, merge, [commit("merge", MERGED_AT)]),
    ).toBeUndefined();
  });
});

describe("parseGitHubDeployments", () => {
  it("reads deploy workflows and production deployments, ignoring the rest", () => {
    const branches = [{ repository: "acme/api", base: "master" }];
    const parsed = parseGitHubDeployments(branches, {
      data: {
        b0: {
          ref: {
            target: {
              history: {
                nodes: [
                  {
                    oid: "a",
                    committedDate: MERGED_AT,
                    deployments: {
                      nodes: [
                        { environment: "production", latestStatus: { state: "INACTIVE" } },
                        { environment: "github-pages", latestStatus: { state: "FAILURE" } },
                      ],
                    },
                    checkSuites: {
                      nodes: [
                        {
                          status: "COMPLETED",
                          conclusion: "FAILURE",
                          workflowRun: { event: "push", workflow: { name: "CI: Lint & Test" } },
                        },
                        {
                          status: "IN_PROGRESS",
                          conclusion: null,
                          workflowRun: {
                            event: "push",
                            workflow: { name: "Preview: OTA or TestFlight" },
                          },
                        },
                        {
                          status: "COMPLETED",
                          conclusion: "FAILURE",
                          workflowRun: {
                            event: "schedule",
                            workflow: { name: "Sync published guides" },
                          },
                        },
                        {
                          status: "COMPLETED",
                          conclusion: "SKIPPED",
                          workflowRun: { event: "workflow_run", workflow: { name: "Deploy EC2" } },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      },
    });
    expect(parsed.get("acme/api#master")).toEqual([
      { oid: "a", committedDate: MERGED_AT, signals: ["deployed", "pending", "skipped"] },
    ]);
  });
});

describe("checking merged pull requests", () => {
  it("checks recent merges that are not deployed yet, and records what it found", () => {
    const deployed = request(1, { deployment: "deployed" });
    const old = request(2, { mergedAt: "2026-09-20T00:00:00Z" });
    const recent = request(3);
    const mergeCommits = new Map([
      [deployed.url, merge],
      [old.url, merge],
      [recent.url, merge],
    ]);
    const check = deploymentsToCheck([deployed, old, recent], mergeCommits, NOW);
    expect(check.requests.map((entry) => entry.number)).toEqual([3]);
    expect(check.branches).toEqual([{ repository: "acme/api", base: "master" }]);
    const branches = new Map([["acme/api#master", [commit("merge", MERGED_AT, ["deployed"])]]]);
    expect(
      withDeployments([deployed, old, recent], check.requests, mergeCommits, branches),
    ).toEqual([deployed, old, { ...recent, deployment: "deployed" }]);
  });
});
