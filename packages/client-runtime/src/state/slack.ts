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
    resetInbox: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:slack:reset-inbox",
      tag: WS_METHODS.slackResetInbox,
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
    unfollow: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:slack:unfollow",
      tag: WS_METHODS.slackUnfollow,
    }),
    setDismissed: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:slack:set-dismissed",
      tag: WS_METHODS.slackSetDismissed,
    }),
    getChannels: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:slack:get-channels",
      tag: WS_METHODS.slackGetChannels,
    }),
    setChannelExcluded: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:slack:set-channel-excluded",
      tag: WS_METHODS.slackSetChannelExcluded,
    }),
    setConversationOwner: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:slack:set-conversation-owner",
      tag: WS_METHODS.slackSetConversationOwner,
    }),
    setConversationWait: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:slack:set-conversation-wait",
      tag: WS_METHODS.slackSetConversationWait,
    }),
    setReplyDraft: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:slack:set-reply-draft",
      tag: WS_METHODS.slackSetReplyDraft,
    }),
    sendReply: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:slack:send-reply",
      tag: WS_METHODS.slackSendReply,
    }),
    devinConnect: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:slack:devin-connect",
      tag: WS_METHODS.devinConnect,
    }),
    devinDisconnect: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:slack:devin-disconnect",
      tag: WS_METHODS.devinDisconnect,
    }),
    /** Workspace members for the thread owner picker. */
    listMembers: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:slack:list-members",
      tag: WS_METHODS.slackListMembers,
    }),
  };
}
