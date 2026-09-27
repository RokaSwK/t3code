import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { SparklesIcon } from "lucide-react";
import { useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useUpdatePrimarySettings } from "../../hooks/useSettings";
import { useProjects, useServerConfigs, useThreadShell } from "../../state/entities";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

/** The Work agent's first message: what it can do, and what it must not do on its own. */
export const WORK_AGENT_FIRST_PROMPT = [
  "You are my Work agent. The t3-code Work tools show you my work as the Work page does: work_overview, read_slack_conversation, read_t3_thread, update_conversation, draft_slack_reply, start_t3_thread, and message_t3_thread.",
  "",
  "Triage my work now. Start with work_overview, read the conversations and threads you need, and tell me what needs me first, with the next action for each. Then summarize what is in progress and what is waiting.",
  "",
  "You may follow, unfollow, mark done, hand off, or mark as waiting when it is clearly right; tell me what you changed. Where someone is waiting on my answer, draft the reply with draft_slack_reply for me to send; you cannot post in Slack yourself. Ask me before starting or messaging T3 threads.",
].join("\n");

export const WORK_AGENT_TRIAGE_PROMPT =
  "Triage again: what changed since you last looked, and what needs me now?";

/**
 * Opens the user's standing Work agent thread with a triage prompt ready to send. The first
 * time it starts one in the Work agent folder, giving that folder Work access.
 */
export function WorkAgentButton({
  environmentId,
  fallbackRoot,
}: {
  /** The primary environment, where the Work agent lives. */
  readonly environmentId: EnvironmentId | null;
  /** Where the agent lives when no Work agent folder is chosen yet. */
  readonly fallbackRoot: EnvironmentProject | null;
}) {
  const navigate = useNavigate();
  const handleNewThread = useNewThreadHandler();
  const configs = useServerConfigs();
  const projects = useProjects();
  const updateSettings = useUpdatePrimarySettings();
  const settings = environmentId ? configs.get(environmentId)?.settings : undefined;
  const agentThreadId = settings?.workAgentThreadId;
  const agentThread = useThreadShell(
    environmentId && agentThreadId
      ? scopeThreadRef(environmentId, ThreadId.make(agentThreadId))
      : null,
  );
  const [pending, setPending] = useState(false);
  const chosenProjectId = settings?.workAgentProjectIds?.[0];
  const home =
    projects.find(
      (project) => project.environmentId === environmentId && project.id === chosenProjectId,
    ) ?? fallbackRoot;

  const open = async () => {
    if (!environmentId || pending) return;
    // A thread in another folder was started before the folder changed; start over there.
    if (agentThread && (!home || agentThread.projectId === home.id)) {
      const threadRef = scopeThreadRef(environmentId, agentThread.id);
      useComposerDraftStore.getState().setPrompt(threadRef, WORK_AGENT_TRIAGE_PROMPT);
      await navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: agentThread.id },
      });
      return;
    }
    if (!home) {
      toastManager.add({
        type: "error",
        title: "Choose a Work agent folder",
        description: "Pick one in Settings → Work.",
      });
      return;
    }
    setPending(true);
    // Access is granted when the agent's session starts, so it is saved before the first send.
    updateSettings({
      workAgentProjectIds: [...new Set([...(settings?.workAgentProjectIds ?? []), home.id])],
    });
    const result = await settlePromise(() =>
      handleNewThread(scopeProjectRef(environmentId, home.id)),
    );
    setPending(false);
    if (result._tag === "Failure" || result.value === null) {
      const error = result._tag === "Failure" ? squashAtomCommandFailure(result) : null;
      toastManager.add({
        type: "error",
        title: "Could not start the Work agent",
        description: error instanceof Error ? error.message : "Try again from Work.",
      });
      return;
    }
    useComposerDraftStore.getState().setPrompt(result.value.draftId, WORK_AGENT_FIRST_PROMPT);
    updateSettings({ workAgentThreadId: result.value.threadId });
  };

  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={!environmentId || pending}
      onClick={() => void open()}
    >
      <SparklesIcon />
      Work agent
    </Button>
  );
}
