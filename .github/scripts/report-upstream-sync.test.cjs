const assert = require("node:assert/strict");
const test = require("node:test");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const script = resolve(__dirname, "report-upstream-sync.sh");
for (const scenario of ["disabled", "api-failure", "create-failure", "existing"]) {
  test(`reporting ${scenario} preserves the failure summary and lets the caller continue`, () => {
    const dir = mkdtempSync(join(tmpdir(), "fork-sync-"));
    try {
      const summary = join(dir, "summary.md");
      const output = execFileSync(
        "bash",
        [
          "-e",
          "-c",
          `
        source "$REPORT_SCRIPT"
        gh() {
          if [ "$1" = api ]; then
            case "$SCENARIO" in disabled) echo false;; api-failure) return 1;; *) echo true;; esac
          elif [ "$2" = list ]; then
            [ "$SCENARIO" != existing ] || echo 42
            return 0
          else
            return 1
          fi
        }
        report release/stable v1.0.0 'Merge conflicts' 'settings.ts'
        echo next-track
      `,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            REPORT_SCRIPT: script,
            SCENARIO: scenario,
            GH_REPO: "owner/fork",
            GITHUB_STEP_SUMMARY: summary,
            GITHUB_SERVER_URL: "https://github.com",
            GITHUB_REPOSITORY: "owner/fork",
            GITHUB_RUN_ID: "1",
          },
        },
      );
      assert.match(output, /next-track/);
      assert.match(readFileSync(summary, "utf8"), /Merge conflicts[\s\S]*settings.ts/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
