import {
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  type SlackState,
  type SlackThread,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { buildWorkOverview } from "./handlers.ts";

const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const slackTs = (ms: number) => (ms / 1000).toFixed(6);

const project = (id: string, title: string, root: string): OrchestrationProjectShell => ({
  id: ProjectId.make(id),
  title,
  workspaceRoot: root,
  defaultModelSelection: null,
  scripts: [],
  repositoryIdentity: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
});

const thread = (id: string, projectId: string): OrchestrationThreadShell => ({
  id: ThreadId.make(id),
  projectId: ProjectId.make(projectId),
  title: id,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  latestTurn: null,
  createdAt: "2026-09-27T11:00:00.000Z",
  updatedAt: "2026-09-27T11:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: "2026-09-27T11:00:00.000Z",
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

const conversation = (channelId: string, overrides: Partial<SlackThread> = {}): SlackThread => ({
  channelId,
  ts: slackTs(NOW - 60 * 60_000),
  authorName: "Bo",
  markdown: "refunds   double-fire\non retries",
  fileCount: 0,
  edited: false,
  replyCount: 1,
  reactions: [],
  channelName: "app-bugs",
  channelKind: "channel",
  permalink: `https://acme.slack.com/archives/${channelId}/p1790000000000100`,
  startedByMe: true,
  lastReply: { by: "other", authorName: "Cy", ts: slackTs(NOW - 30 * 60_000) },
  ...overrides,
});

const slackState = (overrides: Partial<SlackState>): SlackState => ({
  connection: {
    status: "connected",
    clientId: "1.2",
    teamName: "Acme",
    teamUrl: "https://acme.slack.com/",
    userId: "U1",
    userName: "ada",
  },
  sync: { channelCount: 0, availableChannelCount: 0, syncedChannelCount: 0 },
  threads: [],
  conversations: [],
  dismissed: [],
  includedChannelIds: [],
  conversationOwners: [],
  conversationWaits: [],
  reviewRequests: [],
  authoredPullRequests: [],
  replyDrafts: [],
  devin: { status: "disconnected" },
  ...overrides,
});

describe("buildWorkOverview", () => {
  it("lists channel-linked GitHub work once, outside the new-thread feed", () => {
    const pullRequest = {
      url: "https://github.com/acme/app/pull/42",
      repository: "acme/app",
      number: 42,
      title: "Fix refunds",
      isDraft: false,
      updatedAt: "2026-09-27T11:00:00.000Z",
    };
    const mention = conversation("C1", { pullRequests: [pullRequest] });
    const overview = buildWorkOverview({
      threads: [],
      projects: [],
      slack: slackState({ threads: [mention], reviewRequests: [pullRequest] }),
      workProjectRootIds: undefined,
      statuses: ["needs", "working", "waiting", "watching", "done"],
      includeNewThreads: true,
      limit: 40,
      now: NOW,
    });
    expect(overview.items).toHaveLength(1);
    expect(overview.items[0]?.id).toBe(`slack:C1:${mention.ts}`);
    expect(overview.items[0]?.pullRequests).toHaveLength(1);
    expect(overview.newThreads).toEqual([]);
  });

  it("groups like the Work page: handed-off conversations are watched, waits hold", () => {
    const needs = conversation("C1");
    const handedOff = conversation("C2");
    const waited = conversation("C3");
    const overview = buildWorkOverview({
      threads: [thread("in-folder", "tuyo"), thread("elsewhere", "other")],
      projects: [
        project("tuyo", "tuyoinc", "/Users/ada/tuyoinc"),
        project("other", "side", "/Users/ada/side"),
      ],
      slack: slackState({
        conversations: [needs, handedOff, waited],
        conversationOwners: [{ channelId: "C2", ts: handedOff.ts, userId: "U2", name: "Rick" }],
        conversationWaits: [
          { channelId: "C3", ts: waited.ts, userId: "U3", name: "Eng", at: NOW - 10 * 60_000 },
        ],
      }),
      workProjectRootIds: undefined,
      statuses: ["needs", "working", "waiting", "watching"],
      includeNewThreads: false,
      limit: 40,
      now: NOW,
    });

    const byChannel = new Map(overview.items.map((item) => [item.id, item]));
    expect(byChannel.get("slack:C1:" + needs.ts)).toMatchObject({
      status: "needs",
      reason: "Cy replied",
      conversation: { text: "refunds double-fire on retries", lastReplyBy: "Cy" },
    });
    expect(byChannel.get("slack:C2:" + handedOff.ts)).toMatchObject({
      status: "watching",
      conversation: { owner: "Rick" },
    });
    expect(byChannel.get("slack:C3:" + waited.ts)).toMatchObject({
      status: "waiting",
      reason: "Waiting on Eng",
      conversation: { waitingOn: "Eng" },
    });
    // Only T3 work in the Work folders (the Tuyo workspace by default) is listed.
    const threads = overview.items.flatMap((item) => item.t3Threads.map((entry) => entry.threadId));
    expect(threads).toEqual(["in-folder"]);
    expect(overview.counts).toEqual({ needs: 1, working: 1, waiting: 1, watching: 1, done: 0 });
    expect(overview.projects.map((entry) => entry.projectId)).toEqual(["tuyo", "other"]);
  });
});

it("removes ignored work and its Slack mention from the agent overview", () => {
  const request = {
    url: "https://github.com/acme/app/pull/42",
    repository: "acme/app",
    number: 42,
    title: "Fix refunds",
    isDraft: false,
    updatedAt: "2026-09-27T11:00:00.000Z",
  };
  const overview = buildWorkOverview({
    threads: [],
    projects: [],
    slack: slackState({
      threads: [conversation("C1", { pullRequests: [request] })],
      reviewRequests: [request],
    }),
    workProjectRootIds: undefined,
    workIgnoredItems: [{ keys: ["pr:github.com/acme/app#42"], title: "Ignored", at: NOW }],
    statuses: ["needs", "working", "waiting", "watching", "done"],
    includeNewThreads: true,
    limit: 40,
    now: NOW,
  });
  expect(overview.items).toEqual([]);
  expect(overview.newThreads).toEqual([]);
});

it("keeps ignored work hidden when a second PR mention later joins its Slack conversation", () => {
  const first = {
    url: "https://github.com/acme/app/pull/42",
    repository: "acme/app",
    number: 42,
    title: "Fix refunds",
    isDraft: false,
    updatedAt: "2026-09-27T11:00:00.000Z",
  };
  const second = { ...first, number: 43, url: "https://github.com/acme/app/pull/43" };
  const overview = buildWorkOverview({
    threads: [],
    projects: [],
    slack: slackState({
      conversations: [conversation("C1", { pullRequests: [first, second] })],
      threads: [conversation("C2", { pullRequests: [second] })],
    }),
    workProjectRootIds: undefined,
    workIgnoredItems: [{ keys: ["pr:github.com/acme/app#42"], title: "Ignored", at: NOW }],
    statuses: ["needs", "working", "waiting", "watching", "done"],
    includeNewThreads: true,
    limit: 40,
    now: NOW,
  });
  expect(overview.items).toEqual([]);
  expect(overview.newThreads).toEqual([]);
});
