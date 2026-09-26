import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, SlackThread } from "@t3tools/contracts";
import { FolderIcon } from "lucide-react";
import { useState } from "react";

import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useProjects } from "~/state/entities";
import { Command, CommandInput, CommandItem, CommandList } from "../ui/command";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { toastManager } from "../ui/toast";

/**
 * Picks the project a followed Slack thread starts work in. The new draft carries the Slack
 * link, so the thread is linked the moment it is created.
 */
export function StartThreadFromSlackDialog({
  environmentId,
  thread,
  onOpenChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly thread: SlackThread;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const projects = useProjects();
  const handleNewThread = useNewThreadHandler();
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const search = query.trim().toLocaleLowerCase();
  const candidates = projects
    .filter(
      (project) =>
        project.environmentId === environmentId &&
        `${project.title} ${project.workspaceRoot}`.toLocaleLowerCase().includes(search),
    )
    .toSorted((left, right) => left.title.localeCompare(right.title));
  const start = async (projectId: (typeof candidates)[number]["id"]) => {
    if (pending) return;
    setPending(true);
    const result = await settlePromise(() =>
      handleNewThread(scopeProjectRef(environmentId, projectId), {
        linkedSlackThreads: [thread.permalink],
      }),
    );
    setPending(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not start the thread",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      return;
    }
    onOpenChange(false);
  };
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Start a thread from Slack</DialogTitle>
          <DialogDescription>
            Choose the folder to work in. The new thread links back to the conversation in{" "}
            {thread.channelName}.
          </DialogDescription>
        </DialogHeader>
        <Command mode="none" value={query} onValueChange={setQuery} aria-label="Choose a project">
          <CommandInput placeholder="Search projects…" disabled={pending} />
          <CommandList className="max-h-80 overflow-y-auto">
            {candidates.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                No projects found.
              </div>
            ) : (
              candidates.map((project) => (
                <CommandItem
                  key={project.id}
                  value={project.id}
                  disabled={pending}
                  onClick={() => void start(project.id)}
                >
                  <FolderIcon aria-hidden className="size-4 shrink-0" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{project.title}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {project.workspaceRoot}
                    </span>
                  </span>
                </CommandItem>
              ))
            )}
          </CommandList>
        </Command>
      </DialogPopup>
    </Dialog>
  );
}
