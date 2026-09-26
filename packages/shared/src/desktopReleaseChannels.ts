/** Fork builds keep one installation identity across all three release tracks. */
export function forkDesktopChannel(version: string): "latest" | "nightly" | "personal" | null {
  const match = /^[^-+]+-fork\.(stable|nightly|personal)\.\d+$/.exec(version);
  return match?.[1] === "stable"
    ? "latest"
    : match?.[1] === "nightly"
      ? "nightly"
      : match?.[1] === "personal"
        ? "personal"
        : null;
}

export const FORK_DESKTOP_REPOSITORY = "RokaSwK/t3code";

export function forkDesktopFeedUrl(channel: "latest" | "nightly" | "personal"): string {
  return `https://github.com/${FORK_DESKTOP_REPOSITORY}/releases/download/desktop-${channel === "latest" ? "stable" : channel}`;
}
