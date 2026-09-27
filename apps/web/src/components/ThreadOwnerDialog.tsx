import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ScopedThreadRef,
  SlackMember,
  SlackThreadRef,
  ThreadOwner,
} from "@t3tools/contracts";
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

/** What gets an owner: a T3 thread, or a Slack conversation on the Work page. */
type OwnerTarget =
  | { readonly kind: "thread"; readonly threadRef: ScopedThreadRef }
  | {
      readonly kind: "conversation" | "wait";
      readonly environmentId: EnvironmentId;
      readonly conversation: SlackThreadRef;
    };
type Request = { readonly target: OwnerTarget; readonly resolve: () => void };
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

function requestOwner(target: OwnerTarget): Promise<void> {
  useRequest.getState().request?.resolve();
  return new Promise((resolve) => useRequest.setState({ request: { target, resolve } }));
}

/** Opens the owner picker for a thread. Resolves when it closes, saved or not. */
export function requestThreadOwner(threadRef: ScopedThreadRef): Promise<void> {
  return requestOwner({ kind: "thread", threadRef });
}

/** Opens the owner picker for a Slack conversation; handing it off moves it to Watching. */
export function requestConversationOwner(
  environmentId: EnvironmentId,
  conversation: SlackThreadRef,
): Promise<void> {
  return requestOwner({ kind: "conversation", environmentId, conversation });
}

/** Opens the picker for who a conversation of yours is waiting on, such as a reviewer. */
export function requestConversationWait(
  environmentId: EnvironmentId,
  conversation: SlackThreadRef,
): Promise<void> {
  return requestOwner({ kind: "wait", environmentId, conversation });
}

function targetKey(target: OwnerTarget): string {
  return target.kind === "thread"
    ? `thread:${target.threadRef.environmentId}:${target.threadRef.threadId}`
    : `${target.kind}:${target.environmentId}:${target.conversation.channelId}:${target.conversation.ts}`;
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
    <ThreadOwnerDialog key={targetKey(request.target)} target={request.target} />
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

function memberOf(owner: ThreadOwner) {
  return {
    userId: owner.userId,
    name: owner.name,
    ...(owner.avatarUrl ? { avatarUrl: owner.avatarUrl } : {}),
  };
}

function toOwner(member: SlackMember): ThreadOwner {
  return {
    kind: "slack",
    userId: member.userId,
    name: member.name,
    ...(member.avatarUrl ? { avatarUrl: member.avatarUrl } : {}),
  };
}

/** "You" plus the connected workspace's members; picking one saves it to the target. */
function ThreadOwnerDialog({ target }: { readonly target: OwnerTarget }) {
  const environmentId =
    target.kind === "thread" ? target.threadRef.environmentId : target.environmentId;
  const thread = useThreadShell(target.kind === "thread" ? target.threadRef : null);
  const slack = useSlackState(environmentId);
  const connection = slack?.connection.status === "connected" ? slack.connection : null;
  const listMembers = useAtomCommand(slackEnvironment.listMembers, { reportFailure: false });
  const update = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  const setConversationOwner = useAtomCommand(slackEnvironment.setConversationOwner, {
    reportFailure: false,
  });
  const setConversationWait = useAtomCommand(slackEnvironment.setConversationWait, {
    reportFailure: false,
  });
  const [members, setMembers] = useState<MembersState>({ status: "loading" });
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const connected = connection !== null;
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    void listMembers({ environmentId, input: {} }).then((result) => {
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
  }, [connected, listMembers, environmentId]);

  const sameConversation = (entry: { readonly channelId: string; readonly ts: string }) =>
    target.kind !== "thread" &&
    entry.channelId === target.conversation.channelId &&
    entry.ts === target.conversation.ts;
  const currentOwner =
    target.kind === "thread"
      ? (thread?.owner ?? null)
      : target.kind === "conversation"
        ? (slack?.conversationOwners.find(sameConversation) ?? null)
        : (slack?.conversationWaits.find(sameConversation) ?? null);
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
    const result =
      target.kind === "thread"
        ? await update({
            environmentId,
            input: { threadId: target.threadRef.threadId, owner },
          })
        : await (target.kind === "conversation"
            ? setConversationOwner({
                environmentId,
                input: { ...target.conversation, owner: owner ? memberOf(owner) : null },
              })
            : setConversationWait({
                environmentId,
                input: { ...target.conversation, member: owner ? memberOf(owner) : null },
              }));
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
          <DialogTitle>
            {target.kind === "thread"
              ? "Thread owner"
              : target.kind === "conversation"
                ? "Conversation owner"
                : "Waiting on"}
          </DialogTitle>
          <DialogDescription>
            {target.kind === "thread"
              ? "Who this thread is for. You own the threads you create unless you hand one over."
              : target.kind === "conversation"
                ? "Hand this conversation to someone. It moves to Watching on the Work page, where you still see its updates."
                : "Who you are waiting on, such as a reviewer. It shows as Waiting until someone else replies."}
          </DialogDescription>
        </DialogHeader>
        <Command mode="none" value={query} onValueChange={setQuery} aria-label="Choose an owner">
          <CommandInput placeholder="Search Slack members…" disabled={saving} />
          <CommandList className="max-h-80 overflow-y-auto">
            {showYou ? (
              <CommandItem value="you" disabled={saving} onClick={() => void assign(null)}>
                <UserIcon aria-hidden className="size-4 shrink-0" />
                <span className="flex-1 truncate">{target.kind === "wait" ? "No one" : "You"}</span>
                {currentOwner === null ? (
                  <CheckIcon aria-label="Current owner" className="size-3.5" />
                ) : null}
              </CommandItem>
            ) : null}
            {!connected ? (
              <p className="px-3 py-4 text-xs text-muted-foreground">
                Connect Slack from the Work page to assign workspace members.
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
