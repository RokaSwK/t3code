import type { EnvironmentId, SlackState, SlackThread } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { EllipsisIcon, MessageSquareIcon, MessageSquarePlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { isElectron } from "../../env";
import { useEscapeToGoBack } from "../../hooks/useNavigateBack";
import { useThreadShells } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { slackEnvironment, useSlackState } from "../../state/slack";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button, InlineButton } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { RefreshIcon } from "../ui/refresh-icon";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SlackConnectPanel } from "./SlackConnectPanel";
import { ChannelExclusionsDialog } from "./ChannelExclusionsDialog";
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
}: {
  readonly environmentId: EnvironmentId;
  readonly state: SlackState;
}) {
  const refresh = useAtomCommand(slackEnvironment.refresh);
  const disconnect = useAtomCommand(slackEnvironment.disconnect);
  const [refreshing, setRefreshing] = useState(false);
  if (state.connection.status !== "connected") return null;
  return (
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
        <MenuTrigger render={<Button aria-label="Slack options" size="icon-sm" variant="ghost" />}>
          <EllipsisIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem onClick={() => void disconnect({ environmentId, input: {} })}>
            Disconnect Slack
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}

/** T3 threads already started from this Slack thread, and the way to start another. */
function FollowedThreadActions({
  environmentId,
  thread,
}: {
  readonly environmentId: EnvironmentId;
  readonly thread: SlackThread;
}) {
  const navigate = useNavigate();
  const shells = useThreadShells();
  const [picking, setPicking] = useState(false);
  const [unfollowing, setUnfollowing] = useState(false);
  const unfollow = useAtomCommand(slackEnvironment.unfollow, { reportFailure: false });
  const linked = shells.filter(
    (shell) =>
      shell.environmentId === environmentId &&
      shell.linkedSlackThreads?.includes(thread.permalink) === true,
  );
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 ps-11">
      {linked.map((shell) => (
        <InlineButton
          key={shell.id}
          tone="muted"
          className="max-w-64"
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId: shell.environmentId, threadId: shell.id },
            })
          }
        >
          <MessageSquareIcon />
          <span className="truncate">{shell.title}</span>
        </InlineButton>
      ))}
      <Button size="xs" variant="outline" onClick={() => setPicking(true)}>
        <MessageSquarePlusIcon />
        {linked.length > 0 ? "Start another thread" : "Start thread"}
      </Button>
      <Button
        size="xs"
        variant="ghost"
        disabled={unfollowing}
        onClick={() => {
          setUnfollowing(true);
          void unfollow({
            environmentId,
            input: { channelId: thread.channelId, ts: thread.ts },
          }).then((result) => {
            if (result._tag === "Failure") {
              toastManager.add({ type: "error", title: "Could not unfollow thread" });
            }
            setUnfollowing(false);
          });
        }}
      >
        Unfollow
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

function JobFeed({
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
  const [showDismissed, setShowDismissed] = useState(false);
  const [changing, setChanging] = useState<ReadonlySet<string>>(() => new Set());
  const followedKeys = new Set(state.followed.map((thread) => `${thread.channelId}:${thread.ts}`));
  const dismissedKeys = new Set(
    state.dismissed.map((thread) => `${thread.channelId}:${thread.ts}`),
  );
  // A followed thread moves out of the new list, so marking one does not show it twice.
  const newThreads = state.threads.filter(
    (thread) => !followedKeys.has(`${thread.channelId}:${thread.ts}`),
  );
  const fresh = newThreads.filter(
    (thread) => !dismissedKeys.has(`${thread.channelId}:${thread.ts}`),
  );
  const hidden = newThreads.filter((thread) =>
    dismissedKeys.has(`${thread.channelId}:${thread.ts}`),
  );
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
        toastManager.add({ type: "error", title: "Could not update dismissed thread" });
      }
    });
  };
  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">Following</h2>
        <p className="text-xs text-muted-foreground">
          Threads you reacted to with 👀 anywhere in the workspace. Start a T3 thread from one and
          it links back automatically.
        </p>
      </div>
      {state.followed.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          React with 👀 to a thread below, or in Slack, to follow it here.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {state.followed.map((thread) => (
            <SlackThreadItem
              key={`${thread.channelId}:${thread.ts}`}
              environmentId={environmentId}
              thread={thread}
              footer={<FollowedThreadActions environmentId={environmentId} thread={thread} />}
            />
          ))}
        </div>
      )}
      <div className="flex flex-col gap-1 pt-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium">New threads</h2>
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
              : hidden.length > 0
                ? "All new threads are dismissed."
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
                <div className="ps-11">
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={changing.has(`${thread.channelId}:${thread.ts}`)}
                    onClick={() => changeDismissed(thread, true)}
                  >
                    <XIcon />
                    Dismiss
                  </Button>
                </div>
              }
            />
          ))}
        </div>
      )}
      {hidden.length > 0 ? (
        <div className="flex flex-col gap-3">
          <div>
            <Button size="xs" variant="ghost" onClick={() => setShowDismissed(!showDismissed)}>
              {showDismissed ? "Hide" : "Show"} dismissed ({hidden.length})
            </Button>
          </div>
          {showDismissed
            ? hidden.map((thread) => (
                <SlackThreadItem
                  key={`${thread.channelId}:${thread.ts}`}
                  environmentId={environmentId}
                  thread={thread}
                  footer={
                    <div className="ps-11">
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={changing.has(`${thread.channelId}:${thread.ts}`)}
                        onClick={() => changeDismissed(thread, false)}
                      >
                        Restore
                      </Button>
                    </div>
                  }
                />
              ))
            : null}
        </div>
      ) : null}
    </>
  );
}

/** Linked work and the Slack feed that can start new work. */
export function JobPage() {
  useEscapeToGoBack();
  const environmentId = usePrimaryEnvironmentId();
  const state = useSlackState(environmentId);
  const [managingChannels, setManagingChannels] = useState(false);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Work breadcrumb" className="min-w-0">
            <WorkspaceBreadcrumbItem current>
              <h1>Work</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          {environmentId && state ? (
            <JobHeaderActions environmentId={environmentId} state={state} />
          ) : null}
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="readable" className="gap-4">
            <WorkOverview />
            <div className="border-t border-border pt-4">
              <h2 className="text-sm font-medium">Slack inbox</h2>
            </div>
            {environmentId === null ? (
              <p className="text-sm text-muted-foreground">Connect to a T3 Code server first.</p>
            ) : state === null ? (
              <Skeleton className="h-40 w-full" />
            ) : state.connection.status === "connected" ? (
              <JobFeed
                environmentId={environmentId}
                state={state}
                onManageChannels={() => setManagingChannels(true)}
              />
            ) : (
              <SlackConnectPanel environmentId={environmentId} connection={state.connection} />
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
      {environmentId && state?.connection.status === "connected" ? (
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
