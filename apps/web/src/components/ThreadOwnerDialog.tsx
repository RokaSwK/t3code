import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef, SlackMember, ThreadOwner } from "@t3tools/contracts";
import { CheckIcon, UserIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";

import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { slackEnvironment, useSlackState } from "~/state/slack";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { Command, CommandInput, CommandItem, CommandList } from "./ui/command";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "./ui/dialog";
import { toastManager } from "./ui/toast";

type Request = { readonly threadRef: ScopedThreadRef; readonly resolve: () => void };
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/** Opens the owner picker for a thread. Resolves when it closes, saved or not. */
export function requestThreadOwner(threadRef: ScopedThreadRef): Promise<void> {
  useRequest.getState().request?.resolve();
  return new Promise((resolve) => useRequest.setState({ request: { threadRef, resolve } }));
}

function finish() {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve();
}

export function ThreadOwnerDialogHost() {
  const request = useRequest((state) => state.request);
  useEffect(() => () => finish(), []);
  return request ? (
    <ThreadOwnerDialog
      key={`${request.threadRef.environmentId}:${request.threadRef.threadId}`}
      threadRef={request.threadRef}
    />
  ) : null;
}

/** The owner's Slack avatar, or their initial when Slack has none. */
export function ThreadOwnerAvatar({
  owner,
  className,
}: {
  readonly owner: ThreadOwner;
  readonly className?: string;
}) {
  return owner.avatarUrl ? (
    <img
      alt=""
      className={cn("shrink-0 rounded-full bg-muted object-cover", className)}
      loading="lazy"
      src={owner.avatarUrl}
    />
  ) : (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full bg-muted text-3xs font-medium uppercase text-muted-foreground",
        className,
      )}
    >
      {owner.name.slice(0, 1)}
    </span>
  );
}

type MembersState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly members: ReadonlyArray<SlackMember> }
  | { readonly status: "error"; readonly message: string };

function toOwner(member: SlackMember): ThreadOwner {
  return {
    kind: "slack",
    userId: member.userId,
    name: member.name,
    ...(member.avatarUrl ? { avatarUrl: member.avatarUrl } : {}),
  };
}

/** "You" plus the connected workspace's members; picking one saves it to the thread. */
function ThreadOwnerDialog({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const thread = useThreadShell(threadRef);
  const slack = useSlackState(threadRef.environmentId);
  const connection = slack?.connection.status === "connected" ? slack.connection : null;
  const listMembers = useAtomCommand(slackEnvironment.listMembers, { reportFailure: false });
  const update = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  const [members, setMembers] = useState<MembersState>({ status: "loading" });
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const connected = connection !== null;
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    void listMembers({ environmentId: threadRef.environmentId, input: {} }).then((result) => {
      if (cancelled) return;
      if (result._tag === "Success") {
        setMembers({ status: "ready", members: result.value });
        return;
      }
      const cause = squashAtomCommandFailure(result);
      setMembers({
        status: "error",
        message: cause instanceof Error ? cause.message : "Could not load Slack members.",
      });
    });
    return () => {
      cancelled = true;
    };
  }, [connected, listMembers, threadRef.environmentId]);

  const currentOwner = thread?.owner ?? null;
  const search = query.trim().toLocaleLowerCase();
  const showYou = search.length === 0 || "you".includes(search) || "me".includes(search);
  const candidates =
    members.status === "ready"
      ? members.members.filter(
          (member) =>
            member.userId !== connection?.userId &&
            member.name.toLocaleLowerCase().includes(search),
        )
      : [];

  const assign = async (owner: ThreadOwner | null) => {
    if (saving) return;
    setSaving(true);
    const result = await update({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, owner },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not assign the owner",
        description: cause instanceof Error ? cause.message : "An error occurred.",
      });
      return;
    }
    finish();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish();
      }}
    >
      <DialogPopup className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Thread owner</DialogTitle>
          <DialogDescription>
            Who this thread is for. You own the threads you create unless you hand one over.
          </DialogDescription>
        </DialogHeader>
        <Command mode="none" value={query} onValueChange={setQuery} aria-label="Choose an owner">
          <CommandInput placeholder="Search Slack members…" disabled={saving} />
          <CommandList className="max-h-80 overflow-y-auto">
            {showYou ? (
              <CommandItem value="you" disabled={saving} onClick={() => void assign(null)}>
                <UserIcon aria-hidden className="size-4 shrink-0" />
                <span className="flex-1 truncate">You</span>
                {currentOwner === null ? (
                  <CheckIcon aria-label="Current owner" className="size-3.5" />
                ) : null}
              </CommandItem>
            ) : null}
            {!connected ? (
              <p className="px-3 py-4 text-xs text-muted-foreground">
                Connect Slack from the Job page to assign workspace members.
              </p>
            ) : members.status === "loading" ? (
              <p className="px-3 py-4 text-xs text-muted-foreground" role="status">
                Loading members…
              </p>
            ) : members.status === "error" ? (
              <p className="px-3 py-4 text-xs text-destructive" role="alert">
                {members.message}
              </p>
            ) : (
              candidates.map((member) => {
                const owner = toOwner(member);
                return (
                  <CommandItem
                    key={member.userId}
                    value={member.userId}
                    disabled={saving}
                    onClick={() => void assign(owner)}
                  >
                    <ThreadOwnerAvatar owner={owner} className="size-5" />
                    <span className="flex-1 truncate">{member.name}</span>
                    {currentOwner?.userId === member.userId ? (
                      <CheckIcon aria-label="Current owner" className="size-3.5" />
                    ) : null}
                  </CommandItem>
                );
              })
            )}
            {connected && members.status === "ready" && candidates.length === 0 && !showYou ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                No members match.
              </div>
            ) : null}
          </CommandList>
        </Command>
      </DialogPopup>
    </Dialog>
  );
}
