import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createWorkRecapEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    summarize: createEnvironmentRpcCommand(runtime, {
      label: "work:recap-summary",
      tag: WS_METHODS.workRecapSummary,
    }),
  };
}
