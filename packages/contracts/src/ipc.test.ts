import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DesktopAppBrandingSchema, DesktopEnvironmentBootstrapSchema } from "./ipc.ts";

const encodeBranding = Schema.encodeSync(DesktopAppBrandingSchema);
const decodeBranding = Schema.decodeSync(DesktopAppBrandingSchema);

describe("DesktopAppBrandingSchema", () => {
  it("allows personal build branding across the desktop bridge", () => {
    const branding = {
      baseName: "T3 Code",
      stageLabel: "Personal" as const,
      displayName: "T3 Code (Personal)",
    };
    expect(encodeBranding(branding)).toEqual(branding);
    expect(decodeBranding(branding)).toEqual(branding);
  });
});

describe("DesktopEnvironmentBootstrapSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopEnvironmentBootstrapSchema);

  it("preserves the concrete running distro separately from the backend id", () => {
    expect(
      decode({
        id: "wsl:default",
        label: "WSL (Ubuntu)",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
      }),
    ).toEqual({
      id: "wsl:default",
      label: "WSL (Ubuntu)",
      runningDistro: "Ubuntu",
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
    });
  });

  it("allows non-running and non-WSL bootstraps to report no running distro", () => {
    expect(
      decode({
        id: "primary",
        label: "Windows",
        runningDistro: null,
        httpBaseUrl: null,
        wsBaseUrl: null,
      }).runningDistro,
    ).toBeNull();
  });
});
