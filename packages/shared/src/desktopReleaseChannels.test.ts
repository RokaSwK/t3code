import { describe, expect, it } from "vite-plus/test";
import { forkDesktopChannel, forkDesktopFeedUrl } from "./desktopReleaseChannels.ts";

describe("fork desktop releases", () => {
  it.each([
    ["stable", "latest"],
    ["nightly", "nightly"],
    ["personal", "personal"],
  ] as const)("recognizes %s and keeps its own feed", (name, channel) => {
    expect(forkDesktopChannel(`0.0.43-fork.${name}.20260926180000`)).toBe(channel);
    expect(forkDesktopFeedUrl(channel)).toBe(
      `https://github.com/RokaSwK/t3code/releases/download/desktop-${name}`,
    );
  });
  it.each([
    "0.0.43",
    "0.0.43-nightly.20260926.1",
    "0.0.43-foo-fork.personal.1",
    "0.0.43-fork.personal.bad",
  ])("does not treat %s as a managed fork release", (version) => {
    expect(forkDesktopChannel(version)).toBeNull();
  });
});
