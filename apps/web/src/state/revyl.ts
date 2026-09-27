import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/** Whether the environment's `revyl` CLI is signed in, and its active cloud devices. */
export const revylState = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:revyl:state",
  tag: WS_METHODS.revylState,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});

export const revylStart = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:revyl:start",
  tag: WS_METHODS.revylStart,
});

export const revylStop = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:revyl:stop",
  tag: WS_METHODS.revylStop,
});

export const revylInput = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:revyl:input",
  tag: WS_METHODS.revylInput,
});
