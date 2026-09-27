import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/** Adds Codex and Claude app sessions this environment does not have yet as threads. */
export const agentSessionSync = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:sync",
  tag: WS_METHODS.agentSessionsSync,
});

/** When the environment last looked for new sessions and what it added. */
export const agentSessionSyncStatus = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:sync-status",
  tag: WS_METHODS.agentSessionsSyncStatus,
  staleTimeMs: 10_000,
  idleTtlMs: 60_000,
});

/** What a pass added, in a sentence for a toast or a settings row. */
export function describeAgentSessionSync(result: {
  readonly addedThreads: number;
  readonly createdProjects: number;
}): string {
  if (result.addedThreads === 0 && result.createdProjects === 0) return "No new sessions";
  const parts = [
    `${result.addedThreads} ${result.addedThreads === 1 ? "thread" : "threads"}`,
    ...(result.createdProjects > 0
      ? [`${result.createdProjects} ${result.createdProjects === 1 ? "project" : "projects"}`]
      : []),
  ];
  return `Added ${parts.join(" and ")}`;
}
