import { describe, expect, it } from "vite-plus/test";
import {
  compareForkDesktopVersions,
  forkDesktopChannel,
  forkDesktopFeedUrl,
  forkDesktopReleaseApiUrl,
  forkDesktopReleaseTag,
  pickForkDesktopAsset,
} from "./desktopReleaseChannels.ts";

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

describe("fork release assets", () => {
  it("picks the newest archive for the machine's architecture", () => {
    const assets = [
      { name: "T3-Code-0.0.42-fork.personal.20260926161912-arm64.zip", url: "a" },
      { name: "T3-Code-0.0.42-fork.personal.20260926180331-arm64.zip", url: "b" },
      { name: "T3-Code-0.0.43-fork.personal.20260926000000-x64.zip", url: "c" },
      { name: "latest-mac.yml", url: "d" },
    ];
    expect(pickForkDesktopAsset(assets, "arm64")?.url).toBe("b");
    expect(pickForkDesktopAsset(assets, "arm64")?.version).toBe(
      "0.0.42-fork.personal.20260926180331",
    );
    expect(pickForkDesktopAsset(assets, "x64")?.url).toBe("c");
    expect(pickForkDesktopAsset(assets, "ia32")).toBeNull();
  });
  it("orders by base version before build time and treats other tracks alike", () => {
    expect(
      compareForkDesktopVersions(
        "0.0.42-fork.personal.20260926180331",
        "0.0.42-fork.personal.20260926161912",
      ),
    ).toBeGreaterThan(0);
    expect(
      compareForkDesktopVersions(
        "0.0.43-fork.nightly.20260101000000",
        "0.0.42-fork.personal.20260926180331",
      ),
    ).toBeGreaterThan(0);
    expect(compareForkDesktopVersions("0.0.42-fork.stable.1", "0.0.42-fork.personal.1")).toBe(0);
    expect(compareForkDesktopVersions("0.0.42", "0.0.42-fork.personal.1")).toBeLessThan(0);
  });
  it("names the release each track publishes into", () => {
    expect(forkDesktopReleaseTag("latest")).toBe("desktop-stable");
    expect(forkDesktopReleaseApiUrl("personal")).toBe(
      "https://api.github.com/repos/RokaSwK/t3code/releases/tags/desktop-personal",
    );
  });
});
