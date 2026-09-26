import type { EnvironmentId, SlackState, SlackThread } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { EllipsisIcon, MessageSquareIcon, MessageSquarePlusIcon } from "lucide-react";
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
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SlackConnectPanel } from "./SlackConnectPanel";
import { SlackThreadItem } from "./SlackThreadItem";
import { StartThreadFromSlackDialog } from "./StartThreadFromSlackDialog";

function syncLabel(sync: SlackState["sync"]): string {
  if (sync.rateLimitedUntil) {
    return `Slack asked us to slow down; resuming ${new Date(sync.rateLimitedUntil).toLocaleTimeString()}`;
  }
  if (sync.channelCount === 0) return "Finding your channels…";
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
}: {
  readonly environmentId: EnvironmentId;
  readonly state: SlackState;
}) {
  const settling = state.sync.syncedChannelCount < state.sync.channelCount;
  const followedKeys = new Set(state.followed.map((thread) => `${thread.channelId}:${thread.ts}`));
  // A followed thread moves out of the new list, so marking one does not show it twice.
  const fresh = state.threads.filter(
    (thread) => !followedKeys.has(`${thread.channelId}:${thread.ts}`),
  );
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
        <h2 className="text-sm font-medium">New threads</h2>
        <p className="text-xs text-muted-foreground">
          {syncLabel(state.sync)}
          {state.sync.error ? ` · ${state.sync.error}` : ""}
        </p>
      </div>
      {fresh.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {settling || state.sync.channelCount === 0
            ? "Threads show up here as channels are read."
            : "No new threads in your channels in the last day."}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {fresh.map((thread) => (
            <SlackThreadItem
              key={`${thread.channelId}:${thread.ts}`}
              environmentId={environmentId}
              thread={thread}
            />
          ))}
        </div>
      )}
    </>
  );
}

/** Work that arrives from outside T3 Code: Slack threads you follow, and new ones. */
export function JobPage() {
  useEscapeToGoBack();
  const environmentId = usePrimaryEnvironmentId();
  const state = useSlackState(environmentId);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Job breadcrumb" className="min-w-0">
            <WorkspaceBreadcrumbItem current>
              <h1>Job</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          {environmentId && state ? (
            <JobHeaderActions environmentId={environmentId} state={state} />
          ) : null}
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="readable" className="gap-4">
            {environmentId === null ? (
              <p className="text-sm text-muted-foreground">Connect to a T3 Code server first.</p>
            ) : state === null ? (
              <Skeleton className="h-40 w-full" />
            ) : state.connection.status === "connected" ? (
              <JobFeed environmentId={environmentId} state={state} />
            ) : (
              <SlackConnectPanel environmentId={environmentId} connection={state.connection} />
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
