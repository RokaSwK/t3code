import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** Slack connection and thread feed for one environment. */
export function createSlackEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** Server-pushed connection, sync progress, and feed. */
    state: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:slack:state",
      tag: WS_METHODS.subscribeSlackState,
    }),
    connect: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:slack:connect",
      tag: WS_METHODS.slackConnect,
    }),
    completeConnect: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:slack:complete-connect",
      tag: WS_METHODS.slackCompleteConnect,
    }),
    cancelConnect: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:slack:cancel-connect",
      tag: WS_METHODS.slackCancelConnect,
    }),
    disconnect: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:slack:disconnect",
      tag: WS_METHODS.slackDisconnect,
    }),
    refresh: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:slack:refresh",
      tag: WS_METHODS.slackRefresh,
    }),
    getThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:slack:get-thread",
      tag: WS_METHODS.slackGetThread,
    }),
    getReplies: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:slack:get-replies",
      tag: WS_METHODS.slackGetReplies,
    }),
    setReaction: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:slack:set-reaction",
      tag: WS_METHODS.slackSetReaction,
    }),
  };
}
