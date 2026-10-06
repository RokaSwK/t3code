import {
  FORK_CHANGELOG_MARKER,
  parseForkReleaseChangelog,
} from "@t3tools/shared/desktopReleaseChannels";
import { describe, expect, it } from "vite-plus/test";

import { forkChangelogBlock } from "./fork-release-notes.ts";

const previousBody = [
  "Version: `0.0.42-fork.personal.20260927000000`",
  "",
  FORK_CHANGELOG_MARKER,
  "",
  "## 0.0.42-fork.personal.20260927000000",
  "- fix: older — jaime (ours)",
].join("\n");

describe("fork release notes", () => {
  it("adds this build above the previous ones, marking who made each change", () => {
    const block = forkChangelogBlock({
      version: "0.0.43-fork.personal.20260928000000",
      changes: [
        { subject: "feat(work): recap", author: "jaime", ours: true },
        { subject: "fix(web): tooltip", author: "Julius", ours: false },
      ],
      notes: ["Upstream v0.0.43-nightly.1 is not in this build: merging it conflicts."],
      previousBody,
    });
    expect(parseForkReleaseChangelog(`Header\n\n${block}`, "0.0.41-fork.personal.1")).toEqual([
      {
        version: "0.0.43-fork.personal.20260928000000",
        note: [
          "- fix(web): tooltip — Julius (upstream)",
          "- feat(work): recap — jaime (ours)",
          "- Upstream v0.0.43-nightly.1 is not in this build: merging it conflicts.",
        ].join("\n"),
      },
      { version: "0.0.42-fork.personal.20260927000000", note: "- fix: older — jaime (ours)" },
    ]);
  });

  it("keeps the previous sections when a build changes nothing", () => {
    const block = forkChangelogBlock({
      version: "0.0.43-fork.personal.20260928000000",
      changes: [],
      notes: [],
      previousBody,
    });
    expect(parseForkReleaseChangelog(block, "0.0.41-fork.personal.1")).toHaveLength(1);
  });
});
