# Personal fork releases

One **T3 Code.app** installation can run Stable, Nightly, or Personal. Settings → About → Update track selects a track. On macOS every track updates in place: the app reads the track's GitHub release, downloads the newest archive for its architecture, verifies the ad-hoc signature, and swaps the bundle in `/Applications` after it quits, keeping the old bundle in a temp directory as the fallback if the swap fails. Apple signing is not required for this; see `apps/desktop/src/updates/ForkUpdater.ts`.

The tracks deliberately keep separate data: Stable uses `~/.t3-fork-stable`, Nightly uses `~/.t3-fork-nightly`, and Personal retains `~/.t3-personal`. An explicit `T3CODE_HOME` overrides this isolation. Switching back reopens the previous track's threads. Repositories on disk are shared; threads and settings are not.

## Publish

The `Fork desktop releases` workflow builds Apple Silicon macOS archives from `release/stable`, `release/nightly`, or `personal`. Pushes publish the corresponding track; workflow dispatch can build one or all. Stable and Nightly branches contain the channel infrastructure applied to upstream release tags, without the Personal Slack additions. Update those branches by merging the corresponding upstream release tag, resolving conflicts, and running focused checks before pushing. Do not simply label the Personal branch Stable.

Each build uses `<base>-fork.<track>.<UTC timestamp>`, the same bundle ID, and the same app name. Release tags `desktop-stable`, `desktop-nightly`, and `desktop-personal` are the permanent download locations. Release notes record the exact source commit; those moving download pages are not immutable version tags.

## Enable signed updates later

Configure the fork's existing Apple signing inputs: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_TEAM_ID`, and the provisioning profile when required. Run the workflow with **signed** enabled for each track, then set the repository variable `FORK_SIGNED_RELEASES=true` so subsequent pushes also sign. Manually install a signed build once to replace the current ad-hoc-signed installation. Later track switches use the normal updater.

Unsigned builds omit electron-updater feeds and manifests; the in-app fork updater does not use them. Never publish an unsigned archive into a signed update feed or disable macOS signature verification to work around missing credentials.
