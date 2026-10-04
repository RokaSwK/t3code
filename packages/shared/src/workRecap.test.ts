import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type SlackState,
  type SlackThread,
} from "@t3tools/contracts";

import { buildWorkGroups, workItemKeys, type WorkThread } from "./work.ts";
import {
  buildWorkAccomplishments,
  buildWorkPlan,
  parseRecapCitations,
  splitRecapSummary,
  workRecapFeatureSize,
  workRecapItemSize,
  workSourceLines,
} from "./workRecap.ts";

const now = Date.parse("2026-09-28T12:00:00Z");
const done = "2026-09-27T09:00:00Z";
const request = {
  url: "https://github.com/acme/app/pull/42",
  repository: "acme/app",
  number: 42,
  title: "Ship refunds",
  isDraft: false,
  updatedAt: done,
  mergedAt: done,
};
const thread: WorkThread = {
  environmentId: EnvironmentId.make("env"),
  id: ThreadId.make("thread"),
  projectId: ProjectId.make("project"),
  title: "Ship refunds",
  updatedAt: done,
  archivedAt: null,
  settledAt: done,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  latestTurn: null,
  backgroundLiveness: null,
  linkedSlackThreads: [],
  pullRequests: [
    {
      host: "github.com",
      repository: request.repository,
      number: 42,
      url: request.url,
      source: "manual",
      linkedAt: done,
      snapshot: {
        state: "merged",
        title: request.title,
        headBranch: "fix",
        baseBranch: "main",
        isDraft: false,
        updatedAt: done,
        syncedAt: done,
        mergedAt: done,
      },
      stack: null,
    },
  ],
};
const conversation: SlackThread = {
  channelId: "C1",
  ts: "1790499600.000000",
  authorName: "Me",
  markdown: "Ship refunds",
  fileCount: 0,
  edited: false,
  replyCount: 0,
  reactions: [],
  channelName: "work",
  channelKind: "channel",
  permalink: "https://acme.slack.com/archives/C1/p1790499600000000",
  startedByMe: true,
  pullRequests: [request],
};
const slack = (overrides: Partial<SlackState> = {}): SlackState => ({
  connection: { status: "disconnected" },
  sync: { channelCount: 0, availableChannelCount: 0, syncedChannelCount: 0 },
  includedChannelIds: [],
  devin: { status: "disconnected" },
  conversations: [],
  mentions: [],
  events: { status: "off" },
  threads: [],
  dismissed: [],
  conversationOwners: [],
  conversationWaits: [],
  replyDrafts: [],
  reviewRequests: [],
  authoredPullRequests: [],
  ...overrides,
});
const CHANGED = new Set<string>(["thread"]);
const recap = (
  groups = buildWorkGroups([thread], { now }),
  state: SlackState | null = null,
  ignored: Parameters<typeof buildWorkAccomplishments>[0]["ignored"] = [],
) =>
  buildWorkAccomplishments({
    groups,
    threads: [thread],
    slack: state,
    ignored,
    githubOwners: undefined,
    changedThreadIds: CHANGED,
    since: now - 7 * 86400000,
    now,
  });

describe("work recap", () => {
  it("counts a merged PR, its settled thread, and its Slack completion once", () => {
    const state = slack({
      conversations: [conversation],
      mergedPullRequests: [request],
      dismissed: [{ channelId: "C1", ts: conversation.ts, at: Date.parse(done) }],
    });
    const groups = buildWorkGroups([thread], {
      conversations: state.conversations,
      dismissed: state.dismissed,
      now,
    });
    expect(recap(groups, state)).toHaveLength(1);
    // The PR's lines and the conversation's replies count once for the one item.
    const sized = slack({
      ...state,
      conversations: [{ ...conversation, replyCount: 6 }],
      mergedPullRequests: [{ ...request, sourceLines: 120 }],
    });
    expect(
      recap(
        buildWorkGroups([thread], {
          conversations: sized.conversations,
          dismissed: sized.dismissed,
          now,
        }),
        sized,
      ),
    ).toMatchObject([{ sourceLines: 120, slackMessages: 6 }]);
    expect(
      recap(groups, state, [{ keys: workItemKeys(groups[0]!), title: "Ignored", at: now }]),
    ).toEqual([]);
  });
  it("includes explicitly completed channel items without a T3 thread", () => {
    const result = buildWorkAccomplishments({
      groups: [],
      threads: [],
      slack: slack({
        threads: [conversation],
        dismissed: [{ channelId: "C1", ts: conversation.ts, at: Date.parse(done) }],
      }),
      ignored: [],
      githubOwners: undefined,
      changedThreadIds: CHANGED,
      since: now - 86400000 * 7,
      now,
    });
    expect(result).toMatchObject([{ evidence: "Marked done", at: Date.parse(done) }]);
  });
  it("does not infer a completion from quiet status or a fresh update", () => {
    const group = buildWorkGroups([thread], { now })[0]!;
    expect(
      buildWorkAccomplishments({
        groups: [{ ...group, status: "done", markedDone: false, pullRequests: [] }],
        threads: [],
        slack: null,
        ignored: [],
        githubOwners: undefined,
        changedThreadIds: CHANGED,
        since: now - 86400000 * 7,
        now,
      }),
    ).toEqual([]);
    expect(
      recap(
        [],
        slack({
          mergedPullRequests: [{ ...request, mergedAt: "2026-08-01T00:00:00Z", updatedAt: done }],
        }),
      ),
    ).toHaveLength(1); // only the settled thread
  });
  it("counts a settled thread only when it changed files or joined tracked work", () => {
    const chat = { ...thread, id: ThreadId.make("chat"), pullRequests: [] };
    const settled = (changed: boolean) =>
      buildWorkAccomplishments({
        groups: buildWorkGroups([chat], { now }),
        threads: [chat],
        slack: null,
        ignored: [],
        githubOwners: undefined,
        changedThreadIds: new Set(changed ? [chat.id] : []),
        since: now - 86400000 * 7,
        now,
      });
    expect(settled(false)).toEqual([]);
    expect(settled(true)).toMatchObject([
      { evidence: "Thread settled", project: { projectId: chat.projectId } },
    ]);
  });
});

it("consolidates planned Slack and GitHub items when sync joins them", () => {
  const group = buildWorkGroups([thread], { conversations: [conversation], now })[0]!;
  const marks = [
    { keys: ["pr:github.com/acme/app#42"], title: "PR", at: now },
    { keys: [`thread:${thread.environmentId}:${thread.id}`], title: "Thread", at: now },
  ];
  expect(buildWorkPlan(marks, [group], [])).toHaveLength(1);
  expect(buildWorkPlan(marks, [group], [marks[0]!])).toEqual([]);
});

it("leaves out Slack posts that were only dismissed", () => {
  const post = { ...conversation, startedByMe: false };
  expect(
    buildWorkAccomplishments({
      groups: [],
      threads: [],
      slack: slack({
        threads: [post],
        dismissed: [{ channelId: "C1", ts: post.ts, at: Date.parse(done) }],
      }),
      ignored: [],
      githubOwners: undefined,
      changedThreadIds: CHANGED,
      since: now - 86400000 * 7,
      now,
    }),
  ).toEqual([]);
});

describe("recap citations", () => {
  const refs = new Map([
    ["F1", { kind: "feature" as const, id: "f12" }],
    ["F2", { kind: "feature" as const, id: "f7" }],
    ["I1", { kind: "item" as const, id: "pr:github.com/acme/app#42" }],
  ]);

  it("strips every id and keeps only the ones the prompt gave out", () => {
    const parsed = parseRecapCitations(
      " I shipped card freezing [F1] and refund emails [f2, F9]. Also [I1][W0] a fix [F44].",
      refs,
    );
    expect(parsed.text).toBe("I shipped card freezing and refund emails. Also a fix.");
    expect(parsed.citations).toEqual([
      { at: "I shipped card freezing".length, kind: "feature", id: "f12" },
      { at: "I shipped card freezing and refund emails".length, kind: "feature", id: "f7" },
      {
        at: "I shipped card freezing and refund emails. Also".length,
        kind: "item",
        id: refs.get("I1")!.id,
      },
    ]);
  });

  it("splits text into runs that each end where citations go", () => {
    const { text, citations } = parseRecapCitations("Card freezing [F1, F2] shipped.", refs);
    expect(splitRecapSummary(text, citations)).toEqual([
      { text: "Card freezing", citations: [citations[0], citations[1]] },
      { text: " shipped.", citations: [] },
    ]);
    // Summaries written before citations render as one plain run.
    expect(splitRecapSummary("Old summary.")).toEqual([{ text: "Old summary.", citations: [] }]);
  });
});

describe("work size", () => {
  it("counts source lines only, not tests, generated files, lockfiles, or vendored code", () => {
    const file = (path: string) => ({ path, additions: 10, deletions: 5 });
    expect(
      workSourceLines([
        file("apps/web/src/Recap.tsx"),
        file("apps/web/src/Recap.test.tsx"),
        file("spec/models/user_spec.rb"),
        file("pnpm-lock.yaml"),
        file("ios/Podfile.lock"),
        file("src/__snapshots__/Recap.snap"),
        file("src/api/generated/client.ts"),
        file(".repos/effect/index.ts"),
        file("vendor/lib.js"),
        file("server/billing.go"),
        file("server/billing_test.go"),
      ]),
    ).toBe(30);
  });

  it("grows with diminishing returns, and a feature is led by its biggest item", () => {
    expect(workRecapItemSize({})).toBe(1);
    expect(workRecapItemSize({ sourceLines: 25 })).toBe(2);
    expect(workRecapItemSize({ sourceLines: 75, slackMessages: 2 })).toBe(4);
    const big = { sourceLines: 2_000 };
    const small = { sourceLines: 10 };
    expect(workRecapItemSize(big)).toBeLessThan(workRecapItemSize(small) * 6);
    // Five small items do not outweigh one big one.
    expect(workRecapFeatureSize([big])).toBeGreaterThan(
      workRecapFeatureSize([small, small, small, small, small]),
    );
  });
});
