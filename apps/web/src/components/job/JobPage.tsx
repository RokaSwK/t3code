import {
  type EnvironmentId,
  SLACK_FOLLOW_REACTION,
  type SlackState,
  type SlackThread,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, EllipsisIcon, EyeIcon, MessageSquarePlusIcon } from "lucide-react";
import { useState } from "react";

import { isElectron } from "../../env";
import { useEscapeToGoBack } from "../../hooks/useNavigateBack";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { slackEnvironment, useSlackState } from "../../state/slack";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { RefreshIcon } from "../ui/refresh-icon";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { ChannelExclusionsDialog } from "./ChannelExclusionsDialog";
import { slackThreadDoneReason } from "./slackInbox";
import { SlackThreadItem } from "./SlackThreadItem";
import { StartThreadFromSlackDialog } from "./StartThreadFromSlackDialog";
import { WorkOverview } from "./WorkOverview";

function syncLabel(sync: SlackState["sync"]): string {
  if (sync.rateLimitedUntil) {
    return `Slack asked us to slow down; resuming ${new Date(sync.rateLimitedUntil).toLocaleTimeString()}`;
  }
  if (sync.channelCount === 0) {
    return sync.availableChannelCount > 0 ? "All channels excluded" : "Finding your channels…";
  }
  if (sync.syncedChannelCount < sync.channelCount) {
    return `Reading channels ${sync.syncedChannelCount} of ${sync.channelCount}…`;
  }
  return sync.lastSyncedAt
    ? `${sync.channelCount} channels, updated ${formatRelativeTimeLabel(sync.lastSyncedAt)}`
    : `${sync.channelCount} channels`;
}

function JobHeaderActions({
  environmentId,
  state,
  onManageChannels,
}: {
  readonly environmentId: EnvironmentId;
  readonly state: SlackState;
  readonly onManageChannels: () => void;
}) {
  const navigate = useNavigate();
  const refresh = useAtomCommand(slackEnvironment.refresh);
  const resetInbox = useAtomCommand(slackEnvironment.resetInbox, { reportFailure: false });
  const [refreshing, setRefreshing] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  if (state.connection.status !== "connected") return null;
  return (
    <>
      <div className="ms-auto flex min-w-0 items-center gap-1">
        <span className="hidden min-w-0 truncate text-xs text-muted-foreground md:block">
          {state.connection.teamName} as {state.connection.userName}
        </span>
        <Button
          aria-label="Check Slack now"
          aria-busy={refreshing}
          disabled={refreshing}
          size="icon-sm"
          variant="ghost"
          onClick={() => {
            setRefreshing(true);
            void refresh({ environmentId, input: {} }).finally(() => setRefreshing(false));
          }}
        >
          <RefreshIcon size="sm" refreshing={refreshing} />
        </Button>
        <Menu>
          <MenuTrigger
            render={<Button aria-label="Slack options" size="icon-sm" variant="ghost" />}
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={onManageChannels}>Choose channels…</MenuItem>
            <MenuItem onClick={() => setConfirmReset(true)}>Reset Slack inbox</MenuItem>
            <MenuItem onClick={() => void navigate({ to: "/settings/work" })}>
              Slack and Devin settings
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset Slack inbox?</AlertDialogTitle>
            <AlertDialogDescription>
              Clear threads marked done and channel exclusions. Only conversations started after
              this reset will appear on this page. T3 threads, Slack links, and your 👀 reactions in
              Slack stay in place.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={resetting}
              onClick={() => {
                setResetting(true);
                void resetInbox({ environmentId, input: {} }).then((result) => {
                  setResetting(false);
                  if (result._tag === "Failure") {
                    toastManager.add({ type: "error", title: "Could not reset Slack inbox" });
                  } else {
                    setConfirmReset(false);
                  }
                });
              }}
            >
              Reset inbox
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

/** Follow, start work from, or clear a new thread. */
function NewThreadActions({
  environmentId,
  thread,
  busy,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly thread: SlackThread;
  readonly busy: boolean;
  readonly onDone: () => void;
}) {
  const setReaction = useAtomCommand(slackEnvironment.setReaction, { reportFailure: false });
  const [picking, setPicking] = useState(false);
  const follow = () =>
    void setReaction({
      environmentId,
      input: {
        channelId: thread.channelId,
        ts: thread.ts,
        name: SLACK_FOLLOW_REACTION,
        reacted: true,
      },
    }).then((result) => {
      if (result._tag === "Failure") {
        toastManager.add({ type: "error", title: "Could not follow thread" });
      }
    });
  return (
    <div className="flex flex-wrap items-center gap-2 ps-11">
      <Button size="xs" variant="outline" onClick={follow}>
        <EyeIcon />
        Follow
      </Button>
      <Button
        size="xs"
        variant="ghost"
        onClick={() => {
          // Work started from a thread makes it yours, so it moves up into Your work.
          follow();
          setPicking(true);
        }}
      >
        <MessageSquarePlusIcon />
        Start thread
      </Button>
      <Button size="xs" variant="ghost" disabled={busy} onClick={onDone}>
        <CheckIcon />
        Done
      </Button>
      {picking ? (
        <StartThreadFromSlackDialog
          environmentId={environmentId}
          thread={thread}
          onOpenChange={setPicking}
        />
      ) : null}
    </div>
  );
}

/** New threads in your channels that are not yours yet. */
function NewThreadsFeed({
  environmentId,
  state,
  onManageChannels,
}: {
  readonly environmentId: EnvironmentId;
  readonly state: SlackState;
  readonly onManageChannels: () => void;
}) {
  const settling = state.sync.syncedChannelCount < state.sync.channelCount;
  const setDismissed = useAtomCommand(slackEnvironment.setDismissed, { reportFailure: false });
  const [showDone, setShowDone] = useState(false);
  const [changing, setChanging] = useState<ReadonlySet<string>>(() => new Set());
  const mineKeys = new Set(state.conversations.map((thread) => `${thread.channelId}:${thread.ts}`));
  const dismissedKeys = new Set(
    state.dismissed.map((thread) => `${thread.channelId}:${thread.ts}`),
  );
  // A thread that became yours moves up into Your work, so it does not show twice.
  const newThreads = state.threads.filter(
    (thread) => !mineKeys.has(`${thread.channelId}:${thread.ts}`),
  );
  // Done threads, resolved in Slack or on GitHub or marked here, fold away below the open ones.
  const isDone = (thread: SlackThread) =>
    dismissedKeys.has(`${thread.channelId}:${thread.ts}`) || slackThreadDoneReason(thread) !== null;
  const fresh = newThreads.filter((thread) => !isDone(thread));
  const done = newThreads.filter(isDone);
  const changeDismissed = (thread: SlackThread, dismissed: boolean) => {
    const key = `${thread.channelId}:${thread.ts}`;
    setChanging((current) => new Set(current).add(key));
    void setDismissed({
      environmentId,
      input: { channelId: thread.channelId, ts: thread.ts, dismissed },
    }).then((result) => {
      setChanging((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      if (result._tag === "Failure") {
        toastManager.add({ type: "error", title: "Could not update the thread" });
      }
    });
  };
  return (
    <section className="flex flex-col gap-3 border-t border-border pt-4" aria-label="New threads">
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium">New in your channels</h2>
          <Button size="xs" variant="ghost" onClick={onManageChannels}>
            Channels
            {state.excludedChannelIds.length > 0
              ? ` (${state.excludedChannelIds.length} excluded)`
              : ""}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {syncLabel(state.sync)}
          {state.sync.error ? ` · ${state.sync.error}` : ""}
        </p>
      </div>
      {fresh.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {state.sync.availableChannelCount > 0 && state.sync.channelCount === 0
            ? "All channels are excluded. Use Channels to include one."
            : settling || state.sync.channelCount === 0
              ? "Threads show up here as channels are read."
              : done.length > 0
                ? "All new threads are done."
                : "No new threads in your channels in the last day."}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {fresh.map((thread) => (
            <SlackThreadItem
              key={`${thread.channelId}:${thread.ts}`}
              environmentId={environmentId}
              thread={thread}
              footer={
                <NewThreadActions
                  environmentId={environmentId}
                  thread={thread}
                  busy={changing.has(`${thread.channelId}:${thread.ts}`)}
                  onDone={() => changeDismissed(thread, true)}
                />
              }
            />
          ))}
        </div>
      )}
      {done.length > 0 ? (
        <div className="flex flex-col gap-3">
          <div>
            <Button size="xs" variant="ghost" onClick={() => setShowDone(!showDone)}>
              {showDone ? "Hide" : "Show"} done ({done.length})
            </Button>
          </div>
          {showDone
            ? done.map((thread) => (
                <SlackThreadItem
                  key={`${thread.channelId}:${thread.ts}`}
                  environmentId={environmentId}
                  thread={thread}
                  footer={
                    // Threads done in Slack or on GitHub reopen there; only a local mark undoes here.
                    slackThreadDoneReason(thread) === null ? (
                      <div className="ps-11">
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={changing.has(`${thread.channelId}:${thread.ts}`)}
                          onClick={() => changeDismissed(thread, false)}
                        >
                          Not done
                        </Button>
                      </div>
                    ) : undefined
                  }
                />
              ))
            : null}
        </div>
      ) : null}
    </section>
  );
}

/** Your Slack conversations and the work on them, then new threads to triage. */
export function JobPage() {
  useEscapeToGoBack();
  const environmentId = usePrimaryEnvironmentId();
  const state = useSlackState(environmentId);
  const [managingChannels, setManagingChannels] = useState(false);
  // Signing in again from Settings keeps the feed; only the connection is being renewed.
  const connected =
    state !== null &&
    (state.connection.status === "connected" ||
      (state.connection.status === "authorizing" && state.connection.connectedAs !== undefined));

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Work breadcrumb" className="min-w-0">
            <WorkspaceBreadcrumbItem current>
              <h1>Tuyo Work</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          {connected && environmentId ? (
            <JobHeaderActions
              environmentId={environmentId}
              state={state}
              onManageChannels={() => setManagingChannels(true)}
            />
          ) : null}
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="readable" className="gap-4">
            <WorkOverview slackState={state} environmentId={environmentId} />
            {connected && environmentId ? (
              <NewThreadsFeed
                environmentId={environmentId}
                state={state}
                onManageChannels={() => setManagingChannels(true)}
              />
            ) : null}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
      {connected && environmentId ? (
        <ChannelExclusionsDialog
          environmentId={environmentId}
          state={state}
          open={managingChannels}
          onOpenChange={setManagingChannels}
        />
      ) : null}
    </SidebarInset>
  );
}
