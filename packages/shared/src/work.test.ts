import {
  EnvironmentId,
  ProjectId,
  type SlackThread,
  ThreadId,
  type ThreadPullRequestLink,
  type ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildWorkGroups,
  openWorkMentions,
  workItemKeys,
  workMatchesMarks,
  ungroupedWorkChannelThreads,
  WORK_QUIET_MS,
  type WorkThread,
} from "./work.ts";

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
    const groups = buildWorkGroups(
      [
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
      ],
      { now: Date.parse(now) },
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.threads).toHaveLength(2);
    expect(groups[0]?.pullRequests).toHaveLength(1);
    expect(groups[0]?.pullRequests[0]?.threadRef.environmentId).toBe(EnvironmentId.make("env-2"));
    expect(groups[0]).toMatchObject({ status: "needs", reason: "PR checks failing" });
  });

  it("groups threads by a shared Slack conversation and prioritizes agent input", () => {
    const url = "https://example.slack.com/archives/C123/p1727380800000000";
    const groups = buildWorkGroups(
      [
        thread("first", { linkedSlackThreads: [url] }),
        thread("second", { linkedSlackThreads: [url], hasPendingUserInput: true }),
      ],
      { now: Date.parse(now) },
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      slackLinks: [url],
      status: "needs",
      reason: "Agent needs an answer",
    });
  });

  it("shows pending PR checks as waiting and excludes tombstoned links", () => {
    const groups = buildWorkGroups(
      [
        thread("waiting", {
          pullRequests: [pr({ snapshot: snapshot({ checksState: "pending" }) })],
        }),
        thread("hidden", {
          archivedAt: now,
          pullRequests: [pr({ source: "stack-dismissed" })],
        }),
      ],
      { now: Date.parse(now) },
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ status: "waiting", reason: "PR checks running" });
  });

  it("keeps settled linked work visible as done", () => {
    const groups = buildWorkGroups(
      [
        thread("done", {
          archivedAt: now,
          settledAt: now,
          pullRequests: [pr({ snapshot: snapshot({ state: "merged" }) })],
        }),
      ],
      { now: Date.parse(now) },
    );

    expect(groups[0]).toMatchObject({ status: "done", reason: "Work completed" });
  });
});

const nowMs = Date.parse(now);
const slackTs = (ms: number) => (ms / 1000).toFixed(6);
const permalink = "https://acme.slack.com/archives/C1/p1790000000000100";

function conversation(changes: Partial<SlackThread> = {}): SlackThread {
  return {
    channelId: "C1",
    ts: slackTs(nowMs - 60 * 60_000),
    authorName: "Bo",
    markdown: "refunds double-fire",
    fileCount: 0,
    edited: false,
    replyCount: 1,
    reactions: [],
    channelName: "app-bugs",
    channelKind: "channel",
    permalink,
    startedByMe: true,
    ...changes,
  };
}

const devinSession = (state?: "working" | "waiting" | "finished") => ({
  id: "abc",
  url: "https://app.devin.ai/sessions/abc",
  ...(state ? { state } : {}),
});

describe("buildWorkGroups with Slack conversations", () => {
  const status = (
    value: SlackThread,
    extra: Omit<Parameters<typeof buildWorkGroups>[1], "now"> = {},
  ) => {
    const [group] = buildWorkGroups([], { ...extra, conversations: [value], now: nowMs });
    return [group?.status, group?.reason];
  };

  it("leads with the conversation and attaches T3 threads linked to it", () => {
    const groups = buildWorkGroups(
      [thread("fix", { linkedSlackThreads: [permalink], hasPendingApprovals: true })],
      { conversations: [conversation()], now: nowMs },
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.conversation?.channelName).toBe("app-bugs");
    expect(groups[0]?.threads.map((item) => item.id)).toEqual(["fix"]);
    expect(groups[0]).toMatchObject({ status: "needs", reason: "Agent needs approval" });
  });

  it("needs you when someone else replied or Devin is waiting, and waits after your reply", () => {
    const reply = (by: "me" | "devin" | "other") => ({
      lastReply: { by, authorName: by === "other" ? "Cy" : "x", ts: slackTs(nowMs - 30 * 60_000) },
    });
    expect(status(conversation(reply("other")))).toEqual(["needs", "Cy replied"]);
    expect(status(conversation(reply("me")))).toEqual(["waiting", "Waiting for a reply"]);
    expect(
      status(
        conversation({
          ...reply("devin"),
          devin: { sessions: [devinSession("waiting")], stopped: false, lastMessageTs: "1" },
        }),
      ),
    ).toEqual(["needs", "Devin is waiting for you"]);
    expect(
      status(
        conversation({
          ...reply("devin"),
          devin: { sessions: [devinSession("working")], stopped: false, lastMessageTs: "1" },
        }),
      ),
    ).toEqual(["working", "Devin working"]);
    expect(
      status(
        conversation({
          ...reply("devin"),
          devin: { sessions: [devinSession("finished")], stopped: false, lastMessageTs: "1" },
        }),
      ),
    ).toEqual(["needs", "Devin finished"]);
    expect(status(conversation({ startedByMe: false }))).toEqual(["needs", "No reply yet"]);
  });

  it("is done by a tick, merged PRs, or going quiet, and a new reply reopens a marked thread", () => {
    expect(
      status(conversation({ reactions: [{ name: "white_check_mark", count: 1, reacted: false }] })),
    ).toEqual(["done", "Marked ✅ in Slack"]);
    expect(
      status(
        conversation({
          pullRequests: [
            {
              url: "https://github.com/owner/repo/pull/42",
              repository: "owner/repo",
              number: 42,
              state: "merged",
            },
          ],
        }),
      ),
    ).toEqual(["done", "PR merged"]);
    const quietTs = slackTs(nowMs - WORK_QUIET_MS - 60_000);
    expect(
      status(
        conversation({ ts: quietTs, lastReply: { by: "me", authorName: "Ada", ts: quietTs } }),
      ),
    ).toEqual(["done", "Quiet for 3 days"]);

    const markedAt = nowMs - 2 * 60 * 60_000;
    const dismissed = [{ channelId: "C1", ts: conversation().ts, at: markedAt }];
    const before = { by: "other" as const, authorName: "Cy", ts: slackTs(markedAt - 60_000) };
    const after = { ...before, ts: slackTs(markedAt + 60_000) };
    expect(status(conversation({ lastReply: before }), { dismissed })).toEqual([
      "done",
      "Marked done",
    ]);
    expect(status(conversation({ lastReply: after }), { dismissed })).toEqual([
      "needs",
      "Cy replied",
    ]);
  });
});

describe("openWorkMentions", () => {
  const mention = (channelId: string, minutesAgo: number) => {
    const thread = conversation({
      channelId,
      permalink: `https://acme.slack.com/archives/${channelId}/p1790000000000100`,
      startedByMe: false,
    });
    const ts = slackTs(nowMs - minutesAgo * 60_000);
    return {
      thread,
      message: { ...thread, ts, markdown: "@ada can you check?" },
      permalink: thread.permalink,
    };
  };

  it("leaves out mentions in conversations already on the page", () => {
    const followed = mention("C1", 5);
    const loose = mention("C2", 5);
    const groups = buildWorkGroups([], { conversations: [followed.thread], now: nowMs });
    expect(openWorkMentions([followed, loose], groups, {})).toEqual([loose]);
  });

  it("hides a mention marked done after it was said, until a newer one", () => {
    const old = mention("C2", 30);
    const fresh = mention("C2", 5);
    const dismissed = [{ channelId: "C2", ts: old.thread.ts, at: nowMs - 10 * 60_000 }];
    expect(openWorkMentions([old], [], { dismissed })).toEqual([]);
    expect(openWorkMentions([fresh], [], { dismissed })).toEqual([fresh]);
  });
});

describe("buildWorkGroups with conversation owners", () => {
  it("carries who a conversation was handed to", () => {
    const [group] = buildWorkGroups([], {
      conversations: [conversation()],
      owners: [{ channelId: "C1", ts: conversation().ts, userId: "U2", name: "Rick" }],
      now: nowMs,
    });
    expect(group?.owner).toEqual({
      channelId: "C1",
      ts: conversation().ts,
      userId: "U2",
      name: "Rick",
    });
    const [mine] = buildWorkGroups([], { conversations: [conversation()], now: nowMs });
    expect(mine?.owner).toBeNull();
  });
});

describe("buildWorkGroups handoffs", () => {
  const replyAt = (by: "me" | "devin" | "other", ms: number) => ({
    lastReply: { by, authorName: by === "other" ? "Rick" : "x", ts: slackTs(ms) },
  });
  const status = (value: SlackThread, waits?: Parameters<typeof buildWorkGroups>[1]["waits"]) => {
    const [group] = buildWorkGroups([], {
      conversations: [value],
      ...(waits ? { waits } : {}),
      now: nowMs,
    });
    return [group?.status, group?.reason];
  };

  it("waits on the person you are waiting on until someone replies after that", () => {
    const at = nowMs - 60 * 60_000;
    const waits = [{ channelId: "C1", ts: conversation().ts, userId: "U2", name: "Rick", at }];
    expect(status(conversation(replyAt("other", at - 60_000)), waits)).toEqual([
      "waiting",
      "Waiting on Rick",
    ]);
    expect(status(conversation(replyAt("other", at + 60_000)), waits)).toEqual([
      "needs",
      "Rick replied",
    ]);
  });

  it("treats an open PR after your or Devin's last word as waiting for review", () => {
    const pullRequests = [
      {
        url: "https://github.com/owner/repo/pull/708",
        repository: "owner/repo",
        number: 708,
        state: "open" as const,
      },
    ];
    expect(status(conversation({ ...replyAt("devin", nowMs - 60_000), pullRequests }))).toEqual([
      "waiting",
      "PR open, waiting for review",
    ]);
    expect(status(conversation({ ...replyAt("other", nowMs - 60_000), pullRequests }))).toEqual([
      "needs",
      "Rick replied",
    ]);
  });
});

describe("buildWorkGroups with the GitHub queue", () => {
  const pr = (number: number, changes: Record<string, unknown> = {}) => ({
    url: `https://github.com/owner/repo/pull/${number}`,
    repository: "owner/repo",
    number,
    title: `PR ${number}`,
    isDraft: false,
    updatedAt: now,
    author: "rick",
    ...changes,
  });

  it("lists review requests and your own PRs that nothing else is about", () => {
    const groups = buildWorkGroups([], {
      github: {
        reviewRequests: [pr(1)],
        authored: [
          pr(2, { review: "approved", checks: "passing" }),
          pr(3),
          pr(4, { isDraft: true }),
        ],
      },
      now: nowMs,
    });
    expect(groups.map((group) => [group.pullRequestRole, group.status, group.reason])).toEqual([
      ["review", "needs", "Review requested by rick"],
      ["authored", "needs", "PR approved, ready to merge"],
      ["authored", "waiting", "PR waiting for review"],
      ["authored", "working", "Draft PR"],
    ]);
  });

  it("gives a conversation's PR what GitHub says about it, and does not list it twice", () => {
    const url = "https://github.com/owner/repo/pull/708";
    const groups = buildWorkGroups([], {
      conversations: [
        conversation({
          lastReply: { by: "devin", authorName: "Devin", ts: slackTs(nowMs - 60_000) },
          pullRequests: [{ url, repository: "owner/repo", number: 708, state: "open" }],
        }),
      ],
      github: { reviewRequests: [], authored: [pr(708, { checks: "failing" })] },
      now: nowMs,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ status: "needs", reason: "PR checks failing" });
  });

  it("keeps only the chosen GitHub owners' pull requests in the queue", () => {
    const groups = buildWorkGroups([], {
      github: {
        reviewRequests: [],
        authored: [
          pr(1),
          { ...pr(2), url: "https://github.com/Side/app/pull/2", repository: "Side/app" },
        ],
        owners: ["OWNER"],
      },
      now: nowMs,
    });
    expect(groups.map((group) => group.pullRequest?.number)).toEqual([1]);
  });

  it("puts a GitHub PR under its channel conversation, including URL variants", () => {
    const mention = conversation({
      pullRequests: [
        { ...pr(42), url: "https://github.com/OWNER/repo/pull/42/files?diff=split#top" },
      ],
    });
    const unrelated = conversation({ channelId: "C2", permalink: permalink.replace("C1", "C2") });
    const groups = buildWorkGroups([], {
      channelThreads: [mention, unrelated],
      github: { reviewRequests: [pr(42)], authored: [pr(42)] },
      now: nowMs,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.conversation?.channelId).toBe("C1");
    expect(groups[0]?.pullRequest).toBeNull();
    expect(ungroupedWorkChannelThreads([mention, unrelated], groups)).toEqual([unrelated]);
  });

  it("retains all PRs and Slack links when conversations share work", () => {
    const older = conversation({ pullRequests: [pr(42), pr(43)] });
    const newer = conversation({
      channelId: "C2",
      permalink: permalink.replace("C1", "C2"),
      latestReplyTs: slackTs(nowMs),
      pullRequests: [pr(42)],
    });
    const groups = buildWorkGroups([], {
      conversations: [older, newer],
      channelThreads: [older, newer],
      github: { reviewRequests: [], authored: [pr(42), pr(43)] },
      now: nowMs,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.conversation?.channelId).toBe("C2");
    expect(groups[0]?.conversation?.pullRequests?.map((request) => request.number)).toEqual([
      42, 43,
    ]);
    expect(groups[0]?.slackLinks).toHaveLength(2);
    expect(ungroupedWorkChannelThreads([older, newer], groups)).toEqual([]);
  });

  it("does not promote channel messages for excluded GitHub owners", () => {
    const mention = conversation({ pullRequests: [pr(42)] });
    expect(
      buildWorkGroups([], {
        channelThreads: [mention],
        github: { reviewRequests: [pr(42)], authored: [], owners: ["elsewhere"] },
        now: nowMs,
      }),
    ).toEqual([]);
  });
});

it("keeps an explicitly deferred approved PR in Waiting, including its Slack conversation", () => {
  const url = "https://example.slack.com/archives/C123/p1727380800000000";
  const waiting = thread("wait", {
    waitingForMergeAt: now,
    linkedSlackThreads: [url],
    pullRequests: [pr({ snapshot: snapshot({ reviewDecision: "approved" }) })],
  });
  const conversation: SlackThread = {
    channelId: "C123",
    ts: "1727380800.000000",
    channelName: "work",
    channelKind: "channel",
    permalink: url,
    markdown: "Ship it",
    fileCount: 0,
    edited: false,
    reactions: [],
    authorName: "Pat",
    replyCount: 1,
    followed: true,
    startedByMe: true,
    lastReply: { by: "other", authorName: "Pat", ts: "1727380800.000001" },
  };
  expect(buildWorkGroups([waiting], { now: Date.parse(now) })[0]).toMatchObject({
    status: "waiting",
    reason: "Waiting for merge",
  });
  expect(
    buildWorkGroups([waiting], { now: Date.parse(now), conversations: [conversation] })[0],
  ).toMatchObject({ status: "waiting", reason: "Waiting for merge" });
  const failed = {
    ...waiting,
    pullRequests: [pr({ snapshot: snapshot({ checksState: "failing" }) })],
  };
  expect(
    buildWorkGroups([failed], { now: Date.parse(now), conversations: [conversation] })[0],
  ).toMatchObject({ status: "needs", reason: "PR checks failing" });
});

describe("work dispositions", () => {
  it("keeps ignored and planned identity when a standalone PR joins a Slack conversation", () => {
    const request = {
      url: "https://github.com/owner/repo/pull/42",
      repository: "owner/repo",
      number: 42,
      title: "Fix",
      isDraft: false,
      updatedAt: now,
    };
    const standalone = buildWorkGroups([], {
      now: Date.parse(now),
      github: { reviewRequests: [request], authored: [] },
    })[0]!;
    const mark = { keys: workItemKeys(standalone), title: "Fix", at: Date.parse(now) };
    const grouped = buildWorkGroups(
      [
        thread("linked", {
          pullRequests: [pr()],
          linkedSlackThreads: ["https://acme.slack.com/archives/C1/p1790000000000000"],
        }),
      ],
      { now: Date.parse(now) },
    )[0]!;
    expect(workMatchesMarks(workItemKeys(grouped), [mark])).toBe(true);
    expect(workMatchesMarks(workItemKeys(grouped), [])).toBe(false);
    expect(
      workMatchesMarks(
        workItemKeys(buildWorkGroups([thread("unrelated")], { now: Date.parse(now) })[0]!),
        [mark],
      ),
    ).toBe(false);
  });
});
