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

/** The moving GitHub release each fork track publishes into. */
export function forkDesktopReleaseTag(channel: "latest" | "nightly" | "personal"): string {
  return `desktop-${channel === "latest" ? "stable" : channel}`;
}

export function forkDesktopReleaseApiUrl(channel: "latest" | "nightly" | "personal"): string {
  return `https://api.github.com/repos/${FORK_DESKTOP_REPOSITORY}/releases/tags/${forkDesktopReleaseTag(channel)}`;
}

/** `T3-Code-0.0.42-fork.personal.20260926180331-arm64.zip` → its version and arch. */
export function parseForkDesktopAssetName(
  name: string,
): { readonly version: string; readonly arch: string } | null {
  const match = /^T3-Code-(.+-fork\.(?:stable|nightly|personal)\.\d+)-(arm64|x64)\.zip$/.exec(name);
  return match ? { version: match[1]!, arch: match[2]! } : null;
}

/**
 * Orders fork versions: base version numerically, then the build timestamp. Versions from
 * different tracks compare by the same rule, so switching tracks installs that track's newest.
 */
export function compareForkDesktopVersions(left: string, right: string): number {
  const parse = (version: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)-fork\.(?:stable|nightly|personal)\.(\d+)$/.exec(version);
    return match ? match.slice(1).map(Number) : null;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
  }
  return 0;
}

/** The newest archive for this machine among a release's assets. */
export function pickForkDesktopAsset<T extends { readonly name: string }>(
  assets: ReadonlyArray<T>,
  arch: string,
): (T & { readonly version: string }) | null {
  let best: (T & { readonly version: string }) | null = null;
  for (const asset of assets) {
    const parsed = parseForkDesktopAssetName(asset.name);
    if (!parsed || parsed.arch !== arch) continue;
    if (best === null || compareForkDesktopVersions(parsed.version, best.version) > 0) {
      best = { ...asset, version: parsed.version };
    }
  }
  return best;
}
