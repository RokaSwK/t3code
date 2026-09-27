import { describe, expect, it } from "vite-plus/test";

import { parseRevylSessions, revylInputArgs } from "./RevylService.ts";

const LIST = JSON.stringify([
  {
    index: 0,
    session_id: "old",
    platform: "android",
    viewer_url: "https://app.revyl.ai/sessions/old",
    whep_url: "https://bridge.example/play/a",
    screen_width: 411.4,
    screen_height: 914,
    started_at: "2026-09-27T10:00:00Z",
  },
  { index: 1, session_id: "starting", platform: "ios", started_at: "2026-09-27T12:00:00Z" },
  {
    index: 2,
    session_id: "new",
    platform: "ios",
    screen_width: 440,
    screen_height: 956,
    started_at: "2026-09-27T11:00:00Z",
  },
]);

describe("parseRevylSessions", () => {
  it("lists sessions with a screen newest first and skips ones still starting", () => {
    const sessions = parseRevylSessions(LIST);
    expect(sessions.map((session) => session.sessionId)).toEqual(["new", "old"]);
    expect(sessions[0]).toMatchObject({
      platform: "ios",
      viewerUrl: "https://app.revyl.ai/sessions/new",
      screenWidth: 440,
    });
    expect(sessions[0]?.whepUrl).toBeUndefined();
    expect(sessions[1]).toMatchObject({
      whepUrl: "https://bridge.example/play/a",
      screenWidth: 411,
    });
  });

  it("treats output that is not a session list as no sessions", () => {
    expect(parseRevylSessions("No active sessions")).toEqual([]);
    expect(parseRevylSessions("{}")).toEqual([]);
  });
});

describe("revylInputArgs", () => {
  it("always names the session so parallel sessions never cross", () => {
    expect(
      revylInputArgs({ sessionId: "s1", input: { _tag: "swipe", x: 10, y: 20, direction: "up" } }),
    ).toEqual([
      "device",
      "swipe",
      "--x",
      "10",
      "--y",
      "20",
      "--direction",
      "up",
      "--session-id",
      "s1",
      "--json",
    ]);
    expect(revylInputArgs({ sessionId: "s1", input: { _tag: "type", text: "--x" } })).toEqual([
      "device",
      "type",
      "--text=--x",
      "--session-id",
      "s1",
      "--json",
    ]);
  });
});
