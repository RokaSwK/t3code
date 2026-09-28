import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createWorkCalendarEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    read: createEnvironmentRpcQueryAtomFamily(runtime, {
      staleTimeMs: 60_000,
      idleTtlMs: 60_000,
      label: "work:calendar-read",
      tag: WS_METHODS.workCalendarRead,
    }),
    set: createEnvironmentRpcCommand(runtime, {
      label: "work:calendar-set",
      tag: WS_METHODS.workCalendarSet,
    }),
  };
}
