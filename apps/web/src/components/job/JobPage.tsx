import { WorkRecapDialog } from "./WorkRecapPanel";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, SlackMention, SlackState, SlackThread } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { EllipsisIcon, MessageCircleIcon, PencilLineIcon, SearchIcon, XIcon } from "lucide-react";
import { Fragment, useCallback, useMemo, useRef, useState } from "react";

import { isElectron } from "../../env";
import { useEscapeToGoBack } from "../../hooks/useNavigateBack";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useServerConfigs,
  useThreadShells,
} from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { slackEnvironment, useSlackState } from "../../state/slack";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { PullRequestStateGlyph } from "../pullRequest/pullRequestPresentation";
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
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { RefreshIcon } from "../ui/refresh-icon";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { ThreadOwnerAvatar } from "../ThreadOwnerDialog";
import { ChannelPickerDialog } from "./ChannelPickerDialog";
import { slackThreadDoneReason } from "./slackInbox";
import { WorkAgentButton } from "./WorkAgentButton";
import { WorkDetail, type WorkSelection } from "./WorkDetail";
import {
  buildWorkGroups,
  openWorkMentions,
  slackTsToMs,
  ungroupedWorkChannelThreads,
  type WorkGroup,
} from "./workGroups";
import {
  DEVIN_STATE_PRESENTATION,
  DevinLogo,
  SlackChannelGlyph,
  T3Logo,
  slackMessageSummary,
  WORK_META_SEPARATOR,
  WorkGroupHeader,
  WorkRow,
  WorkRowAuthor,
  WorkStatusDot,
} from "./workPresentation";
import { includedWorkProjects, workRootsForEnvironment } from "./workScope";
import { WorkScopeDialog } from "./WorkScopeDialog";
import { WorkIgnoredDialog } from "./WorkItemActions";
import { workItemKeys, workMatchesMarks, slackWorkItemKeys } from "./workGroups";
import { buildWorkSearchIndex, workSearchMatches } from "./workSearch";

/** New threads are for skimming; the rest of the feed is one click away. */
const NEW_PREVIEW = 8;

const slackIso = (ts: string) => new Date(slackTsToMs(ts)).toISOString();

function syncLabel(sync: SlackState["sync"]): string {
  if (sync.rateLimitedUntil) {
    return `Slack asked us to slow down until ${new Date(sync.rateLimitedUntil).toLocaleTimeString()}`;
  }
  if (sync.channelCount === 0) {
    return sync.availableChannelCount > 0 ? "No channels chosen" : "Finding your channels…";
  }
  if (sync.syncedChannelCount < sync.channelCount) {
    return `Reading channels ${sync.syncedChannelCount} of ${sync.channelCount}…`;
  }
  return sync.lastSyncedAt
    ? `${sync.channelCount} channels · ${formatRelativeTimeLabel(sync.lastSyncedAt)}`
    : `${sync.channelCount} channels`;
}

/** What is working on a conversation, as glyphs after its title. */
function ConversationSignals({
  group,
  devinAvatarUrl,
  hasDraft,
}: {
  readonly group: WorkGroup;
  readonly devinAvatarUrl: string | undefined;
  readonly hasDraft: boolean;
}) {
  const conversation = group.conversation!;
  const session = conversation.devin?.sessions.at(-1);
  const devinState = session?.state ? DEVIN_STATE_PRESENTATION[session.state] : null;
  const pullRequest = conversation.pullRequests?.[0];
  return (
    <>
      {hasDraft ? <PencilLineIcon aria-label="Reply drafted" className="size-3.5" /> : null}
      {session ? (
        <DevinLogo
          url={devinAvatarUrl}
          label={devinState ? `Devin, ${devinState.label}` : "Devin"}
        />
      ) : null}
      {group.threads.length > 0 ? (
        <span className="inline-flex items-center gap-0.5">
          <T3Logo />
          {group.threads.length > 1 ? group.threads.length : null}
        </span>
      ) : null}
      {pullRequest ? (
        <PullRequestStateGlyph
          state={pullRequest.state ?? "open"}
          isDraft={false}
          className="size-3.5"
        />
      ) : null}
      {group.owner ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label={`Owned by ${group.owner.name}`}
                className="inline-flex shrink-0"
              />
            }
          >
            <ThreadOwnerAvatar owner={{ kind: "slack", ...group.owner }} className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">Owned by {group.owner.name}</TooltipPopup>
        </Tooltip>
      ) : null}
    </>
  );
}

function SlackMeta({
  thread,
  reason,
  author = thread,
}: {
  readonly thread: SlackThread;
  readonly reason?: string;
  /** Who wrote the message the row is about, when it is not the conversation's root. */
  readonly author?: Pick<SlackThread, "authorName" | "authorAvatarUrl">;
}) {
  return (
    <>
      <span className="inline-flex min-w-0 max-w-40 shrink items-center gap-1">
        <SlackChannelGlyph kind={thread.channelKind} />
        <span className="truncate">{thread.channelName}</span>
      </span>
      {/* A direct message is named after the person, so the author would repeat it. */}
      {thread.channelKind === "dm" && author.authorName === thread.channelName ? null : (
        <>
          {WORK_META_SEPARATOR}
          <WorkRowAuthor name={author.authorName} avatarUrl={author.authorAvatarUrl} />
        </>
      )}
      {reason ? (
        <>
          {WORK_META_SEPARATOR}
          <span className="min-w-0 truncate">{reason}</span>
        </>
      ) : null}
    </>
  );
}

function JobHeaderMenu({
  environmentId,
  slackConnected,
  onManageChannels,
  onChooseFolders,
  onShowIgnored,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly slackConnected: boolean;
  readonly onManageChannels: () => void;
  readonly onChooseFolders: () => void;
  readonly onShowIgnored: () => void;
}) {
  const navigate = useNavigate();
  const resetInbox = useAtomCommand(slackEnvironment.resetInbox, { reportFailure: false });
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  return (
    <>
      <Menu>
        <MenuTrigger render={<Button aria-label="Work options" size="icon-sm" variant="ghost" />}>
          <EllipsisIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem onClick={onChooseFolders}>Choose folders…</MenuItem>
          <MenuItem onClick={onShowIgnored}>Ignored work…</MenuItem>
          {slackConnected ? (
            <>
              <MenuItem onClick={onManageChannels}>Choose channels…</MenuItem>
              <MenuItem onClick={() => setConfirmReset(true)}>Reset Slack inbox…</MenuItem>
            </>
          ) : null}
          <MenuSeparator />
          <MenuItem onClick={() => void navigate({ to: "/settings/work" })}>
            Slack and Devin settings
          </MenuItem>
        </MenuPopup>
      </Menu>
      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset Slack inbox?</AlertDialogTitle>
            <AlertDialogDescription>
              Clear threads marked done. Only conversations started after this reset will appear on
              this page. T3 threads, Slack links, and your 👀 reactions in Slack stay in place.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={resetting || environmentId === null}
              onClick={() => {
                if (environmentId === null) return;
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

/** Groups of rows by status, then new threads to triage, then everything settled. */
function useWorkList(slackState: SlackState | null) {
  const shells = useThreadShells();
  const projects = useProjects();
  const configs = useServerConfigs();
  const connection = slackState?.connection;
  const slackConnected =
    connection?.status === "connected" ||
    (connection?.status === "authorizing" && connection.connectedAs !== undefined);
  const conversations = slackConnected ? slackState!.conversations : undefined;
  const channelThreads = slackConnected ? slackState!.threads : undefined;
  const dismissed = slackState?.dismissed;
  const owners = slackState?.conversationOwners;
  const waits = slackState?.conversationWaits;
  const reviewRequests = slackConnected ? slackState!.reviewRequests : undefined;
  const authored = slackConnected ? slackState!.authoredPullRequests : undefined;
  // The GitHub queue is read by the primary environment, which also holds this choice.
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const gitHubOwners = primaryEnvironmentId
    ? configs.get(primaryEnvironmentId)?.settings.workGitHubOwners
    : undefined;
  const ignoredItems = primaryEnvironmentId
    ? configs.get(primaryEnvironmentId)?.settings.workIgnoredItems
    : undefined;
  const groups = useMemo(
    () =>
      buildWorkGroups(shells, {
        ...(conversations ? { conversations } : {}),
        ...(channelThreads ? { channelThreads } : {}),
        ...(dismissed ? { dismissed } : {}),
        ...(owners ? { owners } : {}),
        ...(waits ? { waits } : {}),
        ...(reviewRequests && authored
          ? {
              github: {
                reviewRequests,
                authored,
                ...(gitHubOwners ? { owners: gitHubOwners } : {}),
              },
            }
          : {}),
        now: Date.now(),
      }),
    [
      shells,
      conversations,
      channelThreads,
      dismissed,
      owners,
      waits,
      reviewRequests,
      authored,
      gitHubOwners,
    ],
  );
  const includedProjects = useMemo(
    () => includedWorkProjects(projects, configs),
    [projects, configs],
  );
  return useMemo(() => {
    const byRecent = (left: WorkGroup, right: WorkGroup) =>
      right.updatedAt.localeCompare(left.updatedAt);
    const mine = groups
      .filter((group) => !workMatchesMarks(workItemKeys(group), ignoredItems ?? []))
      .filter((group) => group.conversation !== null || group.pullRequest !== null)
      .toSorted(byRecent);
    const included = new Set(
      includedProjects.map((project) => `${project.environmentId}:${project.id}`),
    );
    const other = groups
      .filter((group) => !workMatchesMarks(workItemKeys(group), ignoredItems ?? []))
      .filter(
        (group) =>
          group.conversation === null &&
          group.threads.some((thread) =>
            included.has(`${thread.environmentId}:${thread.projectId}`),
          ),
      )
      .toSorted(byRecent);
    const dismissedKeys = new Set(
      (slackState?.dismissed ?? []).map((thread) => `${thread.channelId}:${thread.ts}`),
    );
    const mentions = slackConnected
      ? openWorkMentions(slackState!.mentions, groups, {
          ...(dismissed ? { dismissed } : {}),
          ...(ignoredItems ? { ignored: ignoredItems } : {}),
        })
      : [];
    // A new thread that mentions you is listed once, as the mention.
    const mentionKeys = new Set(
      mentions.map((mention) => `${mention.thread.channelId}:${mention.thread.ts}`),
    );
    const fresh: SlackThread[] = [];
    const cleared: SlackThread[] = [];
    for (const thread of ungroupedWorkChannelThreads(channelThreads ?? [], groups)) {
      if (workMatchesMarks(slackWorkItemKeys(thread), ignoredItems ?? [])) continue;
      const key = `${thread.channelId}:${thread.ts}`;
      if (mentionKeys.has(key)) continue;
      if (dismissedKeys.has(key) || slackThreadDoneReason(thread) !== null) cleared.push(thread);
      else fresh.push(thread);
    }
    // Handed to someone else: watched, never counted as yours to act on.
    const yours = mine.filter((group) => group.owner === null);
    return {
      slackConnected,
      includedProjects,
      needs: yours.filter((group) => group.status === "needs"),
      working: yours.filter((group) => group.status === "working"),
      waiting: yours.filter((group) => group.status === "waiting"),
      watching: mine.filter((group) => group.owner !== null && group.status !== "done"),
      done: mine.filter((group) => group.status === "done"),
      mentions,
      fresh,
      cleared,
      other,
      all: [...mine, ...other],
      recapGroups: groups.filter(
        (group) =>
          group.conversation !== null ||
          group.pullRequest !== null ||
          group.threads.some((thread) =>
            included.has(`${thread.environmentId}:${thread.projectId}`),
          ),
      ),
    };
  }, [
    groups,
    includedProjects,
    slackConnected,
    slackState,
    channelThreads,
    ignoredItems,
    dismissed,
  ]);
}

type WorkList = ReturnType<typeof useWorkList>;

function selectionFor(list: WorkList, id: string | null): WorkSelection | null {
  if (id === null) return null;
  if (id.startsWith("c:")) {
    const group = list.all.find((candidate) => `c:${candidate.id}` === id);
    if (!group) return null;
    return group.conversation ? { kind: "conversation", group } : { kind: "pullRequest", group };
  }
  if (id.startsWith("w:")) {
    const group = list.other.find((candidate) => `w:${candidate.id}` === id);
    return group ? { kind: "work", group } : null;
  }
  const key = id.slice(2);
  if (id.startsWith("m:")) {
    const mention = list.mentions.find((candidate) => mentionKey(candidate) === key);
    return mention ? { kind: "mention", mention } : null;
  }
  const fresh = list.fresh.find((thread) => `${thread.channelId}:${thread.ts}` === key);
  if (fresh) return { kind: "new", thread: fresh, cleared: false };
  const cleared = list.cleared.find((thread) => `${thread.channelId}:${thread.ts}` === key);
  return cleared ? { kind: "new", thread: cleared, cleared: true } : null;
}

function ConversationRows({
  groups,
  devinAvatarUrl,
  draftKeys,
  selectedId,
  onSelect,
}: {
  readonly groups: ReadonlyArray<WorkGroup>;
  readonly devinAvatarUrl: string | undefined;
  /** `channel:ts` of conversations with a reply drafted. */
  readonly draftKeys: ReadonlySet<string>;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
}) {
  return groups.map((group) =>
    group.conversation ? (
      <WorkRow
        key={group.id}
        id={`c:${group.id}`}
        selected={selectedId === `c:${group.id}`}
        glyph={<WorkStatusDot status={group.status} reason={group.reason} />}
        source="slack"
        title={slackMessageSummary(group.conversation.markdown)}
        signals={
          <ConversationSignals
            group={group}
            devinAvatarUrl={devinAvatarUrl}
            hasDraft={draftKeys.has(`${group.conversation.channelId}:${group.conversation.ts}`)}
          />
        }
        meta={<SlackMeta thread={group.conversation} reason={group.reason} />}
        updatedAt={group.updatedAt}
        onSelect={onSelect}
      />
    ) : group.pullRequest ? (
      <WorkRow
        key={group.id}
        id={`c:${group.id}`}
        selected={selectedId === `c:${group.id}`}
        glyph={<WorkStatusDot status={group.status} reason={group.reason} />}
        source="github"
        title={group.pullRequest.title}
        signals={
          <PullRequestStateGlyph
            state="open"
            isDraft={group.pullRequest.isDraft}
            className="size-3.5"
          />
        }
        meta={
          <>
            <span className="min-w-0 max-w-48 truncate font-mono">
              {group.pullRequest.repository}#{group.pullRequest.number}
            </span>
            {group.pullRequest.author && group.pullRequestRole === "review" ? (
              <>
                {WORK_META_SEPARATOR}
                <WorkRowAuthor
                  name={group.pullRequest.author}
                  avatarUrl={group.pullRequest.authorAvatarUrl}
                />
              </>
            ) : null}
            {WORK_META_SEPARATOR}
            <span className="min-w-0 truncate">{group.reason}</span>
          </>
        }
        updatedAt={group.updatedAt}
        onSelect={onSelect}
      />
    ) : null,
  );
}

const mentionKey = (mention: SlackMention) => `${mention.message.channelId}:${mention.message.ts}`;

function MentionRows({
  mentions,
  selectedId,
  onSelect,
}: {
  readonly mentions: ReadonlyArray<SlackMention>;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
}) {
  return mentions.map((mention) => {
    const id = `m:${mentionKey(mention)}`;
    return (
      <WorkRow
        key={id}
        id={id}
        selected={selectedId === id}
        glyph={<WorkStatusDot status="needs" reason="Mentioned you" />}
        source="slack"
        title={slackMessageSummary(mention.message.markdown)}
        meta={<SlackMeta thread={mention.thread} author={mention.message} />}
        updatedAt={slackIso(mention.message.ts)}
        onSelect={onSelect}
      />
    );
  });
}

function NewThreadRows({
  threads,
  selectedId,
  onSelect,
}: {
  readonly threads: ReadonlyArray<SlackThread>;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
}) {
  return threads.map((thread) => {
    const id = `n:${thread.channelId}:${thread.ts}`;
    return (
      <WorkRow
        key={id}
        id={id}
        selected={selectedId === id}
        glyph={<WorkStatusDot status="new" />}
        source="slack"
        title={slackMessageSummary(thread.markdown)}
        signals={
          thread.replyCount > 0 ? (
            <span className="inline-flex items-center gap-0.5">
              <MessageCircleIcon aria-label="Replies" className="size-3.5" />
              {thread.replyCount}
            </span>
          ) : null
        }
        meta={<SlackMeta thread={thread} />}
        updatedAt={slackIso(thread.latestReplyTs ?? thread.ts)}
        onSelect={onSelect}
      />
    );
  });
}

function OtherWorkRows({
  groups,
  projects,
  selectedId,
  onSelect,
}: {
  readonly groups: ReadonlyArray<WorkGroup>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
}) {
  return groups.map((group) => {
    const primary = group.threads[0]!;
    const project = projects.find(
      (candidate) =>
        candidate.environmentId === primary.environmentId && candidate.id === primary.projectId,
    );
    const pullRequest = group.pullRequests[0]?.snapshot;
    return (
      <WorkRow
        key={group.id}
        id={`w:${group.id}`}
        selected={selectedId === `w:${group.id}`}
        glyph={<WorkStatusDot status={group.status} reason={group.reason} />}
        source="t3"
        title={primary.title}
        signals={
          pullRequest ? (
            <PullRequestStateGlyph
              state={pullRequest.state}
              isDraft={pullRequest.isDraft}
              className="size-3.5"
            />
          ) : null
        }
        meta={
          <>
            {project ? <span className="min-w-0 max-w-40 truncate">{project.title}</span> : null}
            {project ? WORK_META_SEPARATOR : null}
            <span className="min-w-0 truncate">{group.reason}</span>
          </>
        }
        updatedAt={group.updatedAt}
        onSelect={onSelect}
      />
    );
  });
}

function ToggleButton({
  open,
  onToggle,
}: {
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <Button size="xs" variant="ghost" className="-my-1" onClick={onToggle}>
      {open ? "Hide" : "Show"}
    </Button>
  );
}

/** Your Slack conversations and the work on them, grouped by what they need, beside a detail. */
export function JobPage() {
  const environmentId = usePrimaryEnvironmentId();
  const state = useSlackState(environmentId);
  const projects = useProjects();
  const configs = useServerConfigs();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const fullList = useWorkList(state);
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const searching = search.trim().length > 0;
  const searchIndex = useMemo(
    () =>
      buildWorkSearchIndex(
        fullList.all,
        [
          ...fullList.fresh,
          ...fullList.cleared,
          // Searched by what was said to you, under the mention's own key.
          ...fullList.mentions.map((mention) => ({ ...mention.thread, ...mention.message })),
        ],
        projects,
      ),
    [fullList, projects],
  );
  const list = useMemo(() => {
    if (!searching) return fullList;
    const matchesGroup = (group: WorkGroup) =>
      workSearchMatches(searchIndex.groups.get(group.id), search);
    const matchesThread = (thread: Pick<SlackThread, "channelId" | "ts">) =>
      workSearchMatches(searchIndex.threads.get(`${thread.channelId}:${thread.ts}`), search);
    return {
      ...fullList,
      needs: fullList.needs.filter(matchesGroup),
      working: fullList.working.filter(matchesGroup),
      waiting: fullList.waiting.filter(matchesGroup),
      watching: fullList.watching.filter(matchesGroup),
      done: fullList.done.filter(matchesGroup),
      mentions: fullList.mentions.filter((mention) => matchesThread(mention.message)),
      other: fullList.other.filter(matchesGroup),
      fresh: fullList.fresh.filter(matchesThread),
      cleared: fullList.cleared.filter(matchesThread),
    };
  }, [fullList, searchIndex, search, searching]);
  const refresh = useAtomCommand(slackEnvironment.refresh);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [showCleared, setShowCleared] = useState(false);
  const [showAllNew, setShowAllNew] = useState(false);
  const [showOther, setShowOther] = useState(false);
  const [showWatching, setShowWatching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [managingChannels, setManagingChannels] = useState(false);
  const [choosingFolders, setChoosingFolders] = useState(false);
  const [showRecap, setShowRecap] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  const selection = selectionFor(fullList, selectedId);
  const draftKeys = useMemo(
    () => new Set((state?.replyDrafts ?? []).map((draft) => `${draft.channelId}:${draft.ts}`)),
    [state?.replyDrafts],
  );
  // Escape closes the open item before it leaves the page.
  const closeSelection = useCallback(() => setSelectedId(null), []);
  useEscapeToGoBack(selection ? closeSelection : undefined);
  const agentRoot = useMemo(() => {
    const roots = [...new Set(projects.map((project) => project.environmentId))].flatMap((id) =>
      workRootsForEnvironment(projects, id, configs.get(id)),
    );
    return roots.find((project) => project.environmentId === environmentId) ?? roots[0] ?? null;
  }, [projects, configs, environmentId]);
  const active =
    list.needs.length + list.mentions.length + list.working.length + list.waiting.length;
  const resultCount =
    active +
    list.watching.length +
    list.done.length +
    list.other.length +
    list.fresh.length +
    list.cleared.length;
  // Without Slack, T3 work is all there is.
  const otherOpen = searching || showOther || !list.slackConnected;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
          <WorkspacePageHeader electron={isElectron} reserveNativeControls={selection === null}>
            <WorkspaceBreadcrumb ariaLabel="Work breadcrumb" className="min-w-0">
              <WorkspaceBreadcrumbItem current>
                <h1>Tuyo Work</h1>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
            <div className="ms-auto flex min-w-0 items-center gap-1">
              {list.slackConnected && state ? (
                <span className="hidden min-w-0 truncate text-xs text-muted-foreground lg:block">
                  {syncLabel(state.sync)}
                  {state.sync.error ? ` · ${state.sync.error}` : ""}
                </span>
              ) : null}
              <Button size="sm" variant="ghost" onClick={() => setShowRecap(true)}>
                Recap
              </Button>
              <WorkAgentButton environmentId={environmentId} fallbackRoot={agentRoot} />
              {list.slackConnected && environmentId ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        aria-label="Check Slack now"
                        aria-busy={refreshing}
                        disabled={refreshing}
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => {
                          setRefreshing(true);
                          void refresh({ environmentId, input: {} }).finally(() =>
                            setRefreshing(false),
                          );
                        }}
                      />
                    }
                  >
                    <RefreshIcon size="sm" refreshing={refreshing} />
                  </TooltipTrigger>
                  <TooltipPopup side="bottom">Check Slack now</TooltipPopup>
                </Tooltip>
              ) : null}
              <JobHeaderMenu
                environmentId={environmentId}
                slackConnected={list.slackConnected}
                onManageChannels={() => setManagingChannels(true)}
                onChooseFolders={() => setChoosingFolders(true)}
                onShowIgnored={() => setShowIgnored(true)}
              />
            </div>
          </WorkspacePageHeader>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <WorkspacePageContainer width="readable" className="gap-5 px-2 sm:px-3">
              <div className="mx-3">
                <InputGroup>
                  <InputGroupAddon>
                    <SearchIcon aria-hidden="true" />
                  </InputGroupAddon>
                  <InputGroupInput
                    ref={searchRef}
                    type="search"
                    aria-label="Search Tuyo Work"
                    placeholder="Search work…"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape" && search && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        event.stopPropagation();
                        setSearch("");
                      }
                    }}
                  />
                  {search ? (
                    <InputGroupAddon align="inline-end">
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label="Clear search"
                        onClick={() => {
                          setSearch("");
                          searchRef.current?.focus();
                        }}
                      >
                        <XIcon />
                      </Button>
                    </InputGroupAddon>
                  ) : null}
                </InputGroup>
              </div>
              {searching ? (
                <p role="status" className="px-3 text-sm text-muted-foreground">
                  {resultCount === 0
                    ? "No matching work. Try another search."
                    : `${resultCount} ${resultCount === 1 ? "result" : "results"}`}
                </p>
              ) : null}
              {!list.slackConnected ? (
                state === null ? null : (
                  <div className="mx-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-border px-3 py-2.5">
                    <p className="text-sm text-muted-foreground">
                      Connect Slack to see your conversations and Devin sessions here.
                    </p>
                    <Button size="xs" variant="outline" render={<Link to="/settings/work" />}>
                      Set up
                    </Button>
                  </div>
                )
              ) : !searching && active === 0 ? (
                <p className="px-3 text-sm text-muted-foreground">
                  Nothing is open right now. New threads from your channels are below.
                </p>
              ) : null}
              {(
                [
                  ["Needs me", list.needs],
                  ["In progress", list.working],
                  ["Waiting", list.waiting],
                ] as const
              ).map(([label, groups]) => (
                <Fragment key={label}>
                  {groups.length > 0 ? (
                    <section className="flex flex-col">
                      <WorkGroupHeader label={label} count={groups.length} />
                      <ConversationRows
                        devinAvatarUrl={state?.devinAvatarUrl}
                        draftKeys={draftKeys}
                        groups={groups}
                        selectedId={selectedId}
                        onSelect={setSelectedId}
                      />
                    </section>
                  ) : null}
                  {/* Mentions need you too, so they follow what does. */}
                  {label === "Needs me" && list.mentions.length > 0 ? (
                    <section className="flex flex-col">
                      <WorkGroupHeader label="Mentions" count={list.mentions.length} />
                      <MentionRows
                        mentions={list.mentions}
                        selectedId={selectedId}
                        onSelect={setSelectedId}
                      />
                    </section>
                  ) : null}
                </Fragment>
              ))}
              {list.slackConnected &&
              (!searching || list.fresh.length + list.cleared.length > 0) ? (
                <section className="flex flex-col">
                  <WorkGroupHeader
                    label="New in your channels"
                    count={list.fresh.length}
                    action={
                      !searching && list.cleared.length > 0 ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          className="-my-1"
                          onClick={() => setShowCleared(!showCleared)}
                        >
                          {showCleared ? "Hide" : "Show"} cleared {list.cleared.length}
                        </Button>
                      ) : undefined
                    }
                  />
                  {searching && list.fresh.length === 0 ? null : state?.includedChannelIds
                      .length === 0 ? (
                    <div className="flex items-center gap-2 px-3 py-1 text-xs text-muted-foreground">
                      Pick the channels to watch for new threads.
                      <Button size="xs" variant="outline" onClick={() => setManagingChannels(true)}>
                        Choose channels…
                      </Button>
                    </div>
                  ) : list.fresh.length === 0 ? (
                    <p className="px-3 py-1 text-xs text-muted-foreground">
                      No new threads in your channels in the last day.
                    </p>
                  ) : (
                    <>
                      <NewThreadRows
                        threads={
                          searching || showAllNew ? list.fresh : list.fresh.slice(0, NEW_PREVIEW)
                        }
                        selectedId={selectedId}
                        onSelect={setSelectedId}
                      />
                      {!searching && list.fresh.length > NEW_PREVIEW ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          className="ms-8 self-start"
                          onClick={() => setShowAllNew(!showAllNew)}
                        >
                          {showAllNew ? "Show fewer" : `Show all ${list.fresh.length}`}
                        </Button>
                      ) : null}
                    </>
                  )}
                  {searching && list.cleared.length > 0 ? (
                    <WorkGroupHeader label="Cleared" count={list.cleared.length} />
                  ) : null}
                  {searching || showCleared ? (
                    <NewThreadRows
                      threads={list.cleared}
                      selectedId={selectedId}
                      onSelect={setSelectedId}
                    />
                  ) : null}
                </section>
              ) : null}
              {list.watching.length > 0 ? (
                <section className="flex flex-col">
                  <WorkGroupHeader
                    label="Watching"
                    count={list.watching.length}
                    action={
                      !searching ? (
                        <ToggleButton
                          open={showWatching}
                          onToggle={() => setShowWatching(!showWatching)}
                        />
                      ) : undefined
                    }
                  />
                  {searching || showWatching ? (
                    <ConversationRows
                      devinAvatarUrl={state?.devinAvatarUrl}
                      draftKeys={draftKeys}
                      groups={list.watching}
                      selectedId={selectedId}
                      onSelect={setSelectedId}
                    />
                  ) : null}
                </section>
              ) : null}
              {list.done.length > 0 ? (
                <section className="flex flex-col">
                  <WorkGroupHeader
                    label="Done"
                    count={list.done.length}
                    action={
                      !searching ? (
                        <ToggleButton open={showDone} onToggle={() => setShowDone(!showDone)} />
                      ) : undefined
                    }
                  />
                  {searching || showDone ? (
                    <ConversationRows
                      devinAvatarUrl={state?.devinAvatarUrl}
                      draftKeys={draftKeys}
                      groups={list.done}
                      selectedId={selectedId}
                      onSelect={setSelectedId}
                    />
                  ) : null}
                </section>
              ) : null}
              {!searching || list.other.length > 0 ? (
                <section className="flex flex-col">
                  <WorkGroupHeader
                    label="Other work"
                    count={list.other.length}
                    action={
                      !searching && list.slackConnected ? (
                        <ToggleButton open={showOther} onToggle={() => setShowOther(!showOther)} />
                      ) : undefined
                    }
                  />
                  {otherOpen ? (
                    !bootstrapped ? (
                      <p className="px-3 py-1 text-xs text-muted-foreground">
                        Loading work from your environments…
                      </p>
                    ) : list.includedProjects.length === 0 ? (
                      <p className="px-3 py-1 text-xs text-muted-foreground">
                        Choose folders from the menu to show T3 work that is not tied to a Slack
                        conversation.
                      </p>
                    ) : list.other.length === 0 ? (
                      <p className="px-3 py-1 text-xs text-muted-foreground">No other work.</p>
                    ) : (
                      <OtherWorkRows
                        groups={list.other}
                        projects={projects}
                        selectedId={selectedId}
                        onSelect={setSelectedId}
                      />
                    )
                  ) : null}
                </section>
              ) : null}
            </WorkspacePageContainer>
          </div>
        </div>
        {selection ? (
          // Beside the list where there is room; over it on narrow windows.
          <aside
            aria-label="Selected work"
            className="absolute inset-0 z-10 flex min-h-0 flex-col bg-background lg:static lg:w-[min(38rem,50%)] lg:shrink-0 lg:border-l lg:border-border/70"
          >
            <WorkDetail
              selection={selection}
              devinAvatarUrl={state?.devinAvatarUrl}
              environmentId={environmentId}
              projects={projects}
              onClose={closeSelection}
            />
          </aside>
        ) : null}
      </div>
      {list.slackConnected && environmentId && state ? (
        <ChannelPickerDialog
          environmentId={environmentId}
          state={state}
          open={managingChannels}
          onOpenChange={setManagingChannels}
        />
      ) : null}
      <WorkScopeDialog
        open={choosingFolders}
        onOpenChange={setChoosingFolders}
        projects={projects}
        configs={configs}
      />
      <WorkRecapDialog
        open={showRecap}
        onOpenChange={setShowRecap}
        environmentId={environmentId}
        groups={fullList.recapGroups}
        onSelect={(id) => {
          const group = fullList.all.find((item) => item.id === id);
          setSelectedId(`${group?.conversation || group?.pullRequest ? "c" : "w"}:${id}`);
          setShowRecap(false);
        }}
      />
      <WorkIgnoredDialog open={showIgnored} onOpenChange={setShowIgnored} />
    </SidebarInset>
  );
}
