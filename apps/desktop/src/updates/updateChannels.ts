import { forkDesktopChannel } from "@t3tools/shared/desktopReleaseChannels";
import type { DesktopUpdateChannel } from "@t3tools/contracts";

const NIGHTLY_VERSION_PATTERN = /^[^-+]+-nightly\.\d{8}\.\d+$/;
// Preview builds are the maintainers' test train, cut by hand from unreleased
// branches to exercise the release flow. They share nightly's branding but
// are packaged without an update feed (see
// isDesktopPreviewVersion in scripts/build-desktop-artifact.ts), so the
// channel a preview install reports is cosmetic: it never checks for updates
// and no updater feed ever lists a preview release.
const PRERELEASE_VERSION_PATTERN = /^[^-+]+-(?:nightly|preview)\.\d{8}\.\d+$/;

export function isNightlyDesktopVersion(version: string): boolean {
  return forkDesktopChannel(version) === "nightly" || PRERELEASE_VERSION_PATTERN.test(version);
}

/** Includes legacy local builds and the Personal release track. */
export function isPersonalDesktopVersion(version: string): boolean {
  return forkDesktopChannel(version) === "personal" || /^[^-+]+-personal\.\d+$/.test(version);
}

export function resolveDefaultDesktopUpdateChannel(appVersion: string): DesktopUpdateChannel {
  const forkChannel = forkDesktopChannel(appVersion);
  if (forkChannel) return forkChannel;
  if (isPersonalDesktopVersion(appVersion)) return "personal";
  return NIGHTLY_VERSION_PATTERN.test(appVersion) ? "nightly" : "latest";
}
