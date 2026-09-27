import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { WorkGroup } from "./workGroups";
import { buildWorkTriagePrompt } from "./workTriagePrompt";

const group = (status: WorkGroup["status"], reason: string): WorkGroup => ({
  id: reason,
  status,
  reason,
  updatedAt: "2026-09-27T00:00:00.000Z",
  threads: [],
  pullRequests: [
    {
      key: "github.com/tuyoinc/api#42",
      url: "https://github.com/tuyoinc/api/pull/42",
      repository: "tuyoinc/api",
      number: 42,
      threadRef: {
        environmentId: EnvironmentId.make("env"),
        threadId: ThreadId.make("thread"),
      },
      snapshot: null,
    },
  ],
  slackLinks: [],
  conversation: null,
  markedDone: false,
  owner: null,
});

describe("buildWorkTriagePrompt", () => {
  it("prioritizes actionable work, includes source status, and excludes completed items", () => {
    const prompt = buildWorkTriagePrompt(
      [
        group("waiting", "review required"),
        group("needs", "checks failing"),
        group("done", "merged"),
      ],
      [],
    );
    expect(prompt.indexOf("checks failing")).toBeLessThan(prompt.indexOf("review required"));
    expect(prompt).toContain("https://github.com/tuyoinc/api/pull/42");
    expect(prompt).toContain("state: not synced");
    expect(prompt).not.toContain("merged");
    expect(prompt).toContain("give recommendations only");
  });

  it("describes the Slack conversation and Devin sessions a work item is about", () => {
    const prompt = buildWorkTriagePrompt(
      [
        {
          ...group("needs", "Devin is waiting for you"),
          pullRequests: [],
          conversation: {
            channelId: "C1",
            ts: "1.000001",
            authorName: "Ada",
            markdown: "refunds double-fire\non retries",
            fileCount: 0,
            edited: false,
            replyCount: 2,
            reactions: [],
            channelName: "app-bugs",
            channelKind: "channel",
            permalink: "https://acme.slack.com/archives/C1/p1000001",
            lastReply: { by: "devin", authorName: "Devin", ts: "2.000001" },
            devin: {
              sessions: [{ id: "abc", url: "https://app.devin.ai/sessions/abc", state: "waiting" }],
              stopped: false,
              lastMessageTs: "2.000001",
            },
          },
          slackLinks: ["https://acme.slack.com/archives/C1/p1000001"],
        },
      ],
      [],
    );
    expect(prompt).toContain(
      "Slack: #app-bugs · Ada: refunds double-fire on retries | https://acme.slack.com/archives/C1/p1000001 | last reply: Devin",
    );
    expect(prompt).toContain("Devin: https://app.devin.ai/sessions/abc | state: waiting");
    // The conversation's own link is not repeated as a separate Slack line.
    expect(prompt.match(/archives\/C1/g)).toHaveLength(1);
  });
});
