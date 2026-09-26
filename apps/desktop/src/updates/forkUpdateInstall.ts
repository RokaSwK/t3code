/**
 * Pure pieces of the fork updater's install step: where the running bundle is, and the
 * shell script that swaps it once the app has quit. Kept apart from Electron so the swap
 * logic can be tested.
 */
// @effect-diagnostics nodeBuiltinImport:off - pure path math for the swap script.
import * as NodePath from "node:path";

/** `/Applications/T3 Code.app/Contents/MacOS/T3 Code` → `/Applications/T3 Code.app`. */
export function forkAppBundlePath(execPath: string): string | null {
  const bundle = NodePath.resolve(execPath, "..", "..", "..");
  return bundle.endsWith(".app") ? bundle : null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Waits for the running app to exit, moves the old bundle aside, moves the new one into
 * place, and relaunches. A failed swap puts the old bundle back and relaunches that instead,
 * so a broken update never leaves the user without an app. The previous bundle stays in the
 * staging directory until the next update clears it.
 */
export function forkSwapScript(input: {
  readonly pid: number;
  readonly appBundle: string;
  readonly newBundle: string;
  readonly previousBundle: string;
}): string {
  const app = shellQuote(input.appBundle);
  const next = shellQuote(input.newBundle);
  const previous = shellQuote(input.previousBundle);
  return [
    "#!/bin/sh",
    `while kill -0 ${input.pid} 2>/dev/null; do sleep 0.2; done`,
    `rm -rf ${previous}`,
    `if mv ${app} ${previous} && mv ${next} ${app}; then`,
    `  xattr -dr com.apple.quarantine ${app} 2>/dev/null`,
    `  open -n ${app}`,
    "else",
    `  [ -d ${app} ] || mv ${previous} ${app}`,
    `  open -n ${app}`,
    "  exit 1",
    "fi",
    "",
  ].join("\n");
}
