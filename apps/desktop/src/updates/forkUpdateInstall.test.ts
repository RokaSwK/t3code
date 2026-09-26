import { describe, expect, it } from "vite-plus/test";

import { forkAppBundlePath, forkSwapScript } from "./forkUpdateInstall.ts";

describe("forkAppBundlePath", () => {
  it("finds the bundle three levels above the executable", () => {
    expect(forkAppBundlePath("/Applications/T3 Code.app/Contents/MacOS/T3 Code")).toBe(
      "/Applications/T3 Code.app",
    );
    expect(forkAppBundlePath("/usr/local/bin/t3")).toBeNull();
  });
});

describe("forkSwapScript", () => {
  it("waits for the app, swaps bundles, and restores the old one when the swap fails", () => {
    const script = forkSwapScript({
      pid: 42,
      appBundle: "/Applications/T3 Code.app",
      newBundle: "/tmp/stage/T3 Code.app",
      previousBundle: "/tmp/stage/previous.app",
    });
    expect(script).toContain("while kill -0 42");
    expect(script).toContain("mv '/Applications/T3 Code.app' '/tmp/stage/previous.app'");
    expect(script).toContain("mv '/tmp/stage/T3 Code.app' '/Applications/T3 Code.app'");
    expect(script).toContain("xattr -dr com.apple.quarantine '/Applications/T3 Code.app'");
    expect(script).toContain("|| mv '/tmp/stage/previous.app' '/Applications/T3 Code.app'");
    expect(script.match(/open -n '\/Applications\/T3 Code.app'/g)).toHaveLength(2);
  });
  it("quotes single quotes in paths", () => {
    expect(
      forkSwapScript({ pid: 1, appBundle: "/a/it's.app", newBundle: "/b", previousBundle: "/c" }),
    ).toContain(`'/a/it'\\''s.app'`);
  });
});
