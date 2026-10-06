const assert = require("node:assert/strict");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, existsSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

for (const scenario of ["current", "merged", "conflict", "checks-fail", "missing"]) {
  test(`Personal release ${scenario} requires the nightly before publishing`, () => {
    const dir = mkdtempSync(join(tmpdir(), "fork-nightly-"));
    try {
      const summary = join(dir, "summary.md");
      const environment = join(dir, "env");
      const result = spawnSync(
        "bash",
        [
          "-e",
          "-c",
          `
        gh() { if [ "$SCENARIO" = missing ]; then echo null; else echo v1-nightly.1; fi; }
        git() {
          case "$1" in
            merge-base) [ "$SCENARIO" = current ]; return $? ;;
            merge) if [ "$2" = --abort ]; then echo aborted; elif [ "$SCENARIO" = conflict ]; then return 1; fi ;;
            diff) echo settings.ts ;;
          esac
          return 0
        }
        vp() { [ "$SCENARIO" != checks-fail ]; }
        npx() { return 0; }
        source "$NIGHTLY_SCRIPT"
        echo publish-ready
      `,
        ],
        {
          encoding: "utf8",
          cwd: resolve(__dirname, "../.."),
          env: {
            ...process.env,
            SCENARIO: scenario,
            NIGHTLY_SCRIPT: resolve(__dirname, "include-upstream-nightly.sh"),
            GITHUB_STEP_SUMMARY: summary,
            GITHUB_ENV: environment,
          },
        },
      );
      if (scenario === "current" || scenario === "merged") {
        assert.equal(result.status, 0, result.stderr);
        assert.match(readFileSync(environment, "utf8"), /UPSTREAM_NIGHTLY=v1-nightly.1/);
        if (scenario === "merged") assert.match(result.stdout, /publish-ready/);
      } else {
        assert.notEqual(result.status, 0);
        assert.doesNotMatch(result.stdout, /publish-ready/);
        if (scenario === "conflict") {
          assert.match(result.stdout, /aborted/);
          assert.match(readFileSync(summary, "utf8"), /Nightly merge blocked[\s\S]*settings.ts/);
        }
        if (scenario === "missing") assert.equal(existsSync(environment), false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
