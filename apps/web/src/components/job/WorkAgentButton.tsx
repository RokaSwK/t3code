import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { SparklesIcon } from "lucide-react";
import { useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import type { WorkGroup } from "./workGroups";
import { buildWorkTriagePrompt } from "./workTriagePrompt";

export function WorkAgentButton({
  root,
  groups,
  projects,
}: {
  readonly root: EnvironmentProject | null;
  readonly groups: ReadonlyArray<WorkGroup>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
}) {
  const handleNewThread = useNewThreadHandler();
  const [pending, setPending] = useState(false);
  const start = async () => {
    if (!root || pending) return;
    setPending(true);
    const prompt = buildWorkTriagePrompt(groups, projects);
    const result = await settlePromise(() =>
      handleNewThread(scopeProjectRef(root.environmentId, root.id)),
    );
    if (result._tag === "Failure" || result.value === null) {
      const error = result._tag === "Failure" ? squashAtomCommandFailure(result) : null;
      toastManager.add({
        type: "error",
        title: "Could not start Tuyo review",
        description: error instanceof Error ? error.message : "Try again from Work.",
      });
    } else {
      useComposerDraftStore.getState().setPrompt(result.value.draftId, prompt);
    }
    setPending(false);
  };
  return (
    <Button size="xs" variant="ghost" disabled={!root || pending} onClick={() => void start()}>
      <SparklesIcon />
      Review with agent
    </Button>
  );
}
