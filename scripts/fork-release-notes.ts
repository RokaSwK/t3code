#!/usr/bin/env node
// Prints the changelog block of a fork desktop release body: this build's changes, then the
// sections the previous body already carried. The in-app updater shows every section newer
// than the running build (see parseForkReleaseChangelog).
//
//   node scripts/fork-release-notes.ts --version <v> --previous <old-body.md> [--note <line>]...
//
// Commits reachable from refs/upstream/* (upstream main and tags, fetched by the workflow) are
// upstream's; everything else is ours.
// @effect-diagnostics nodeBuiltinImport:off - a CI script that shells out to git.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

import { FORK_CHANGELOG_MARKER } from "@t3tools/shared/desktopReleaseChannels";

const MAX_SECTIONS = 30;
// GitHub caps release bodies at 125,000 characters.
const MAX_BODY_LENGTH = 100_000;

export interface ForkChange {
  readonly subject: string;
  readonly author: string;
  readonly ours: boolean;
}

export function forkChangelogBlock(input: {
  readonly version: string;
  readonly changes: ReadonlyArray<ForkChange>;
  readonly notes: ReadonlyArray<string>;
  readonly previousBody: string;
}): string {
  // The popover lists a section's last lines first, so ours and the notes go last.
  const lines = [
    ...input.changes.filter((change) => !change.ours),
    ...input.changes.filter((change) => change.ours),
  ].map(
    (change) => `- ${change.subject} — ${change.author} (${change.ours ? "ours" : "upstream"})`,
  );
  lines.push(...input.notes.map((note) => `- ${note}`));
  const start = input.previousBody.indexOf(FORK_CHANGELOG_MARKER);
  const previous =
    start < 0
      ? []
      : input.previousBody
          .slice(start + FORK_CHANGELOG_MARKER.length)
          .split(/^(?=## )/m)
          .map((section) => section.trim())
          .filter((section) => section.startsWith("## "));
  const sections = [
    ...(lines.length > 0 ? [`## ${input.version}\n${lines.join("\n")}`] : []),
    ...previous,
  ].slice(0, MAX_SECTIONS);
  while (sections.length > 1 && sections.join("\n\n").length > MAX_BODY_LENGTH) sections.pop();
  return [FORK_CHANGELOG_MARKER, ...sections].join("\n\n") + "\n";
}

function git(...args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", args, { encoding: "utf8" }).trim();
}

function changesSince(since: string | undefined): ForkChange[] {
  if (!since) return [];
  try {
    git("cat-file", "-e", `${since}^{commit}`);
  } catch {
    return [];
  }
  const ours = new Set(
    git("rev-list", "--no-merges", `${since}..HEAD`, "--not", "--glob=refs/upstream/*")
      .split("\n")
      .filter(Boolean),
  );
  return git("log", "--no-merges", "--reverse", "--format=%H%x1f%an%x1f%s", `${since}..HEAD`)
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash = "", author = "", subject = ""] = line.split("\x1f");
      return { subject, author, ours: ours.has(hash) };
    });
}

if (process.argv[1]?.endsWith("fork-release-notes.ts")) {
  const { values } = NodeUtil.parseArgs({
    options: {
      version: { type: "string" },
      previous: { type: "string" },
      note: { type: "string", multiple: true },
    },
  });
  if (!values.version) throw new Error("--version is required");
  const previousBody =
    values.previous && NodeFS.existsSync(values.previous)
      ? NodeFS.readFileSync(values.previous, "utf8")
      : "";
  process.stdout.write(
    forkChangelogBlock({
      version: values.version,
      changes: changesSince(/Source: `([0-9a-f]{40})`/.exec(previousBody)?.[1]),
      notes: values.note ?? [],
      previousBody,
    }),
  );
}
