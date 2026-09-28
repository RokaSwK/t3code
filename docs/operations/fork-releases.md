# Personal fork releases

One **T3 Code.app** installation can run Stable, Nightly, or Personal. Settings → About → Update track selects a track. On macOS every track updates in place: the app reads the track's GitHub release, downloads the newest archive for its architecture, verifies the ad-hoc signature, and swaps the bundle in `/Applications` after it quits, keeping the old bundle in a temp directory as the fallback if the swap fails. Apple signing is not required for this; see `apps/desktop/src/updates/ForkUpdater.ts`.

The tracks deliberately keep separate data: Stable uses `~/.t3-fork-stable`, Nightly uses `~/.t3-fork-nightly`, and Personal retains `~/.t3-personal`. An explicit `T3CODE_HOME` overrides this isolation. Switching back reopens the previous track's threads. Repositories on disk are shared; threads and settings are not.

## Publish

The `Fork desktop releases` workflow builds Apple Silicon macOS archives from `release/stable`, `release/nightly`, or `personal`. Pushes publish the corresponding track; workflow dispatch can build one or all. Stable and Nightly branches contain the channel infrastructure applied to upstream release tags, without the Personal Slack additions. Do not simply label the Personal branch Stable.

The `Fork upstream sync` workflow runs daily and on demand. It merges upstream's latest stable release into `release/stable` and the latest nightly into `release/nightly` and `personal`, runs focused checks, pushes, and dispatches the release build for each track that changed. A conflicting merge or failing checks opens an `Upstream merge needs attention` issue instead of pushing; resolve it by merging the tag locally and pushing, after which the next sync finds nothing to do. The issue title names the branch and tag, so re-runs do not duplicate it.

Every Personal build also merges upstream's newest nightly first, so Personal never waits for the daily sync to stay current. The merge is pushed to `personal` after the build succeeds. If it conflicts or fails typechecks, the build goes out without it, its changelog says so, and the daily sync opens the issue.

Each build uses `<base>-fork.<track>.<UTC timestamp>`, the same bundle ID, and the same app name. Release tags `desktop-stable`, `desktop-nightly`, and `desktop-personal` are the permanent download locations. Release notes record the exact source commit; those moving download pages are not immutable version tags.

Release notes end with a changelog, one section per build, which the app shows when you hover an available update. Each line is a commit since the previous build, marked `ours` or `upstream` (reachable from upstream's `main` or tags) with its author. The section is computed from the `Source:` commit of the previous release body, so keep that line when editing a release by hand.

## Enable signed updates later

Configure the fork's existing Apple signing inputs: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_TEAM_ID`, and the provisioning profile when required. Run the workflow with **signed** enabled for each track, then set the repository variable `FORK_SIGNED_RELEASES=true` so subsequent pushes also sign. Manually install a signed build once to replace the current ad-hoc-signed installation. Later track switches use the normal updater.

Unsigned builds omit electron-updater feeds and manifests; the in-app fork updater does not use them. Never publish an unsigned archive into a signed update feed or disable macOS signature verification to work around missing credentials.
