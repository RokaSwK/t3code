import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type SlackState,
  type SlackThread,
} from "@t3tools/contracts";
import { buildWorkGroups, workItemKeys, type WorkThread } from "./workGroups";
import {
  buildWorkAccomplishments,
  buildWorkPlan,
  localWorkDate,
  workRecapWindows,
} from "./workRecap";
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
  threads: [],
  dismissed: [],
  conversationOwners: [],
  conversationWaits: [],
  replyDrafts: [],
  reviewRequests: [],
  authoredPullRequests: [],
  ...overrides,
});
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
    const settled = (hasChanges: boolean) =>
      buildWorkAccomplishments({
        groups: buildWorkGroups([{ ...chat, hasChanges }], { now }),
        threads: [{ ...chat, hasChanges }],
        slack: null,
        ignored: [],
        githubOwners: undefined,
        since: now - 86400000 * 7,
        now,
      });
    expect(settled(false)).toEqual([]);
    expect(settled(true)).toMatchObject([
      { evidence: "Thread settled", project: { projectId: chat.projectId } },
    ]);
  });
  it("reports from the last workday and the start of the week in local time", () => {
    // Sunday 1 March: the standup covers Friday, the demo covers the week since Monday.
    const sunday = workRecapWindows(new Date(2026, 2, 1, 12));
    expect(localWorkDate(new Date(sunday.lastWorkday))).toBe("2026-02-27");
    expect(new Date(sunday.today).getHours()).toBe(0);
    expect(localWorkDate(new Date(sunday.week))).toBe("2026-02-23");
    const monday = workRecapWindows(new Date(2026, 2, 2, 9));
    expect(localWorkDate(new Date(monday.lastWorkday))).toBe("2026-02-27");
    expect(localWorkDate(new Date(monday.week))).toBe("2026-02-23");
    const wednesday = workRecapWindows(new Date(2026, 2, 4, 9));
    expect(localWorkDate(new Date(wednesday.lastWorkday))).toBe("2026-03-03");
    expect(localWorkDate(new Date(wednesday.week))).toBe("2026-03-02");
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
