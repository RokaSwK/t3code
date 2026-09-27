import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  type EnvironmentId,
  SLACK_FOLLOW_REACTION,
  type SlackPullRequest,
  type SlackThread,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  EyeIcon,
  MessageSquarePlusIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { slackEnvironment } from "~/state/slack";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { PullRequestStateGlyph } from "../pullRequest/pullRequestPresentation";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  requestConversationOwner,
  requestConversationWait,
  ThreadOwnerAvatar,
} from "../ThreadOwnerDialog";
import { SlackConversationView } from "./SlackConversationView";
import { StartThreadFromSlackDialog } from "./StartThreadFromSlackDialog";
import type { WorkGroup, WorkPullRequest, WorkThread } from "./workGroups";
import {
  DEVIN_STATE_PRESENTATION,
  DevinLogo,
  SlackChannelGlyph,
  T3Logo,
  WORK_STATUS_PRESENTATION,
  WorkStatusDot,
} from "./workPresentation";

/** What the detail panel shows: one of your conversations, a new thread, or other T3 work. */
export type WorkSelection =
  | { readonly kind: "conversation"; readonly group: WorkGroup }
  | { readonly kind: "new"; readonly thread: SlackThread; readonly cleared: boolean }
  | { readonly kind: "work"; readonly group: WorkGroup }
  | { readonly kind: "pullRequest"; readonly group: WorkGroup };

function openExternal(url: string) {
  void readLocalApi()?.shell.openExternal(url);
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="px-2 text-xs font-medium text-muted-foreground/70">{title}</h3>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

const LINK_ROW_CLASS =
  "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function ThreadRows({ threads }: { readonly threads: ReadonlyArray<WorkThread> }) {
  const navigate = useNavigate();
  return threads.map((thread) => (
    <button
      key={`${thread.environmentId}:${thread.id}`}
      type="button"
      className={LINK_ROW_CLASS}
      onClick={() =>
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: thread.environmentId, threadId: thread.id },
        })
      }
    >
      <T3Logo className="size-4 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{thread.title}</span>
      <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
        {formatRelativeTimeLabel(thread.updatedAt)}
      </span>
    </button>
  ));
}

function pullRequestSummary(request: WorkPullRequest): string {
  const snapshot = request.snapshot;
  if (snapshot === null) return "status pending";
  if (snapshot.state !== "open") return snapshot.state;
  const parts: string[] = [];
  if (snapshot.checksState === "failing") parts.push("checks failing");
  if (snapshot.checksState === "pending") parts.push("checks running");
  if (snapshot.checksState === "passing") parts.push("checks passing");
  if (snapshot.reviewDecision === "changes-requested") parts.push("changes requested");
  if (snapshot.reviewDecision === "review-required") parts.push("review required");
  if (snapshot.reviewDecision === "approved") parts.push("approved");
  if (snapshot.mergeability === "conflicting") parts.push("conflict");
  return parts.join(" · ") || (snapshot.isDraft ? "draft" : "open");
}

/** PRs from T3 threads carry checks and review; ones linked only in Slack carry their state. */
function PullRequestRows({
  threadRequests,
  slackRequests,
}: {
  readonly threadRequests: ReadonlyArray<WorkPullRequest>;
  readonly slackRequests: ReadonlyArray<SlackPullRequest>;
}) {
  const openPrLink = useOpenPrLink(threadRequests[0]?.threadRef);
  const known = new Set(threadRequests.map((request) => request.url));
  return (
    <>
      {threadRequests.map((request) => (
        <a
          key={request.key}
          className={LINK_ROW_CLASS}
          href={request.url}
          rel="noreferrer"
          target="_blank"
          onClick={(event) => openPrLink(event, request.url, request.threadRef)}
        >
          <PullRequestStateGlyph
            state={request.snapshot?.state ?? "open"}
            isDraft={request.snapshot?.isDraft ?? false}
          />
          <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
            #{request.number}
          </span>
          <span className="min-w-0 flex-1 truncate">
            {request.snapshot?.title ?? request.repository}
          </span>
          <span className="shrink-0 text-2xs text-muted-foreground">
            {pullRequestSummary(request)}
          </span>
        </a>
      ))}
      {slackRequests
        .filter((request) => !known.has(request.url))
        .map((request) => (
          <button
            key={request.url}
            type="button"
            className={LINK_ROW_CLASS}
            onClick={() => openExternal(request.url)}
          >
            <PullRequestStateGlyph state={request.state ?? "open"} isDraft={false} />
            <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
              #{request.number}
            </span>
            <span className="min-w-0 flex-1 truncate">{request.repository}</span>
            <span className="shrink-0 text-2xs text-muted-foreground">
              {request.state ?? "status pending"}
            </span>
          </button>
        ))}
    </>
  );
}

function DevinRows({
  thread,
  devinAvatarUrl,
}: {
  readonly thread: SlackThread;
  readonly devinAvatarUrl: string | undefined;
}) {
  return (thread.devin?.sessions ?? []).map((session) => {
    const state = session.state ? DEVIN_STATE_PRESENTATION[session.state] : null;
    return (
      <button
        key={session.id}
        type="button"
        className={LINK_ROW_CLASS}
        onClick={() => openExternal(session.url)}
      >
        <DevinLogo url={devinAvatarUrl} className="size-4 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{session.title ?? "Devin session"}</span>
        <span className={cn("shrink-0 text-2xs", state?.className ?? "text-muted-foreground")}>
          {state?.label ?? (thread.devin?.stopped ? "asleep" : "Devin")}
        </span>
      </button>
    );
  });
}

function PanelHeader({
  channel,
  onClose,
  children,
}: {
  readonly channel: ReactNode;
  readonly onClose: () => void;
  readonly children?: ReactNode;
}) {
  return (
    <header className="flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1 border-b border-border/70 pr-2 pl-4">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-muted-foreground">
        {channel}
      </div>
      {children}
      <Tooltip>
        <TooltipTrigger
          render={<Button size="icon-sm" variant="ghost" aria-label="Close" onClick={onClose} />}
        >
          <XIcon />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Close (Esc)</TooltipPopup>
      </Tooltip>
    </header>
  );
}

function OpenInSlackButton({ url }: { readonly url: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Open in Slack"
            onClick={() => openExternal(url)}
          />
        }
      >
        <ExternalLinkIcon />
      </TooltipTrigger>
      <TooltipPopup side="bottom">Open in Slack</TooltipPopup>
    </Tooltip>
  );
}

function useConversationActions(environmentId: EnvironmentId, thread: SlackThread) {
  const setDismissed = useAtomCommand(slackEnvironment.setDismissed, { reportFailure: false });
  const setReaction = useAtomCommand(slackEnvironment.setReaction, { reportFailure: false });
  const unfollow = useAtomCommand(slackEnvironment.unfollow, { reportFailure: false });
  const setOwner = useAtomCommand(slackEnvironment.setConversationOwner, {
    reportFailure: false,
  });
  const setWait = useAtomCommand(slackEnvironment.setConversationWait, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const ref = { channelId: thread.channelId, ts: thread.ts };
  const run = (action: () => Promise<{ readonly _tag: string }>, failure: string) => {
    setBusy(true);
    void action().then((result) => {
      setBusy(false);
      if (result._tag === "Failure") toastManager.add({ type: "error", title: failure });
    });
  };
  return {
    busy,
    markDone: (done: boolean) =>
      run(
        () => setDismissed({ environmentId, input: { ...ref, dismissed: done } }),
        "Could not update the conversation",
      ),
    follow: () =>
      run(
        () =>
          setReaction({
            environmentId,
            input: { ...ref, name: SLACK_FOLLOW_REACTION, reacted: true },
          }),
        "Could not follow the thread",
      ),
    unfollow: () => run(() => unfollow({ environmentId, input: ref }), "Could not unfollow"),
    stopWaiting: () =>
      run(
        () => setWait({ environmentId, input: { ...ref, member: null } }),
        "Could not stop waiting",
      ),
    takeBack: () =>
      run(
        () => setOwner({ environmentId, input: { ...ref, owner: null } }),
        "Could not take the conversation back",
      ),
  };
}

function SlackDetail({
  environmentId,
  devinAvatarUrl,
  thread,
  status,
  group,
  cleared,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly devinAvatarUrl: string | undefined;
  readonly thread: SlackThread;
  readonly status: ReactNode;
  readonly group: WorkGroup | null;
  readonly cleared: boolean;
  readonly onClose: () => void;
}) {
  const actions = useConversationActions(environmentId, thread);
  const [picking, setPicking] = useState(false);
  const mine = group !== null;
  const threads = group?.threads ?? [];
  const threadRequests = group?.pullRequests ?? [];
  const slackRequests = thread.pullRequests ?? [];
  const sessions = thread.devin?.sessions ?? [];
  const markedDone = group?.markedDone ?? cleared;
  const canMarkDone = !markedDone && (group === null || group.status !== "done");
  return (
    <>
      <PanelHeader
        onClose={onClose}
        channel={
          <>
            <SlackChannelGlyph kind={thread.channelKind} />
            <span className="truncate">{thread.channelName}</span>
          </>
        }
      >
        <OpenInSlackButton url={thread.permalink} />
        <Menu>
          <MenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="More actions" />}>
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem
              disabled={actions.busy}
              onClick={() => {
                // A conversation handed off is still watched, so it has to be followed.
                if (!mine) actions.follow();
                void requestConversationOwner(environmentId, {
                  channelId: thread.channelId,
                  ts: thread.ts,
                });
              }}
            >
              Assign owner…
            </MenuItem>
            <MenuItem
              disabled={actions.busy}
              onClick={() => {
                if (!mine) actions.follow();
                void requestConversationWait(environmentId, {
                  channelId: thread.channelId,
                  ts: thread.ts,
                });
              }}
            >
              Waiting on…
            </MenuItem>
            {thread.followed ? (
              <MenuItem disabled={actions.busy} onClick={actions.unfollow}>
                Unfollow
              </MenuItem>
            ) : null}
          </MenuPopup>
        </Menu>
      </PanelHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-5 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-1.5 text-xs">{status}</div>
            {group?.waitingOn && !group.owner ? (
              <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <ThreadOwnerAvatar
                  owner={{ kind: "slack", ...group.waitingOn }}
                  className="size-4"
                />
                <span className="truncate">Waiting on {group.waitingOn.name}</span>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={actions.busy}
                  onClick={actions.stopWaiting}
                >
                  Stop waiting
                </Button>
              </span>
            ) : null}
            {group?.owner ? (
              <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <ThreadOwnerAvatar owner={{ kind: "slack", ...group.owner }} className="size-4" />
                <span className="truncate">Owned by {group.owner.name}</span>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={actions.busy}
                  onClick={actions.takeBack}
                >
                  Take back
                </Button>
              </span>
            ) : null}
            {mine ? null : (
              <Button size="xs" variant="outline" disabled={actions.busy} onClick={actions.follow}>
                <EyeIcon />
                Follow
              </Button>
            )}
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                // Work started from a thread makes it yours.
                if (!mine) actions.follow();
                setPicking(true);
              }}
            >
              <MessageSquarePlusIcon />
              {threads.length > 0 ? "Start another thread" : "Start thread"}
            </Button>
            {markedDone ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={actions.busy}
                onClick={() => actions.markDone(false)}
              >
                <RotateCcwIcon />
                Not done
              </Button>
            ) : canMarkDone ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={actions.busy}
                onClick={() => actions.markDone(true)}
              >
                <CheckIcon />
                Done
              </Button>
            ) : null}
          </div>
          {sessions.length > 0 || threads.length > 0 ? (
            <Section title="Working on it">
              <DevinRows thread={thread} devinAvatarUrl={devinAvatarUrl} />
              <ThreadRows threads={threads} />
            </Section>
          ) : null}
          {threadRequests.length > 0 || slackRequests.length > 0 ? (
            <Section title="Pull requests">
              <PullRequestRows threadRequests={threadRequests} slackRequests={slackRequests} />
            </Section>
          ) : null}
          <Section title="Conversation">
            <div className="px-2 pt-1">
              <SlackConversationView environmentId={environmentId} thread={thread} />
            </div>
          </Section>
        </div>
      </div>
      {picking ? (
        <StartThreadFromSlackDialog
          environmentId={environmentId}
          thread={thread}
          onOpenChange={setPicking}
        />
      ) : null}
    </>
  );
}

function StatusLine({ group }: { readonly group: WorkGroup }) {
  const presentation = WORK_STATUS_PRESENTATION[group.status];
  return (
    <>
      <WorkStatusDot status={group.status} reason={group.reason} />
      <span className={cn("font-medium", presentation.textClass)}>{presentation.label}</span>
      <span className="truncate text-muted-foreground">{group.reason}</span>
    </>
  );
}

function T3WorkDetail({
  group,
  projects,
  onClose,
}: {
  readonly group: WorkGroup;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly onClose: () => void;
}) {
  const primary = group.threads[0]!;
  const project = projects.find(
    (candidate) =>
      candidate.environmentId === primary.environmentId && candidate.id === primary.projectId,
  );
  return (
    <>
      <PanelHeader onClose={onClose} channel={<span className="truncate">{project?.title}</span>}>
        {group.slackLinks[0] ? <OpenInSlackButton url={group.slackLinks[0]} /> : null}
      </PanelHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-5 p-4">
          <div className="flex min-w-0 items-center gap-1.5 text-xs">
            <StatusLine group={group} />
          </div>
          <Section title="Threads">
            <ThreadRows threads={group.threads} />
          </Section>
          {group.pullRequests.length > 0 ? (
            <Section title="Pull requests">
              <PullRequestRows threadRequests={group.pullRequests} slackRequests={[]} />
            </Section>
          ) : null}
        </div>
      </div>
    </>
  );
}

const CHECKS_LABELS = {
  passing: "Checks passing",
  failing: "Checks failing",
  pending: "Checks running",
};
const REVIEW_LABELS = {
  approved: "Approved",
  "changes-requested": "Changes requested",
  "review-required": "Review required",
};

/** A pull request from the GitHub queue: where it stands, and a way to open it. */
function PullRequestDetail({
  group,
  onClose,
}: {
  readonly group: WorkGroup;
  readonly onClose: () => void;
}) {
  const pullRequest = group.pullRequest!;
  const openPrLink = useOpenPrLink();
  const facts = [
    pullRequest.isDraft ? "Draft" : null,
    pullRequest.review ? REVIEW_LABELS[pullRequest.review] : null,
    pullRequest.checks ? CHECKS_LABELS[pullRequest.checks] : null,
    pullRequest.conflicting ? "Merge conflict" : null,
  ].filter((fact) => fact !== null);
  return (
    <>
      <PanelHeader
        onClose={onClose}
        channel={
          <span className="truncate font-mono">
            {pullRequest.repository}#{pullRequest.number}
          </span>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-5 p-4">
          <div className="flex min-w-0 items-center gap-1.5 text-xs">
            <StatusLine group={group} />
          </div>
          <Section
            title={
              group.pullRequestRole === "review" ? "Waiting for your review" : "Your pull request"
            }
          >
            <a
              className={LINK_ROW_CLASS}
              href={pullRequest.url}
              rel="noreferrer"
              target="_blank"
              onClick={(event) => openPrLink(event, pullRequest.url)}
            >
              <PullRequestStateGlyph state="open" isDraft={pullRequest.isDraft} />
              <span className="min-w-0 flex-1 truncate">{pullRequest.title}</span>
              {pullRequest.author ? (
                <span className="shrink-0 text-2xs text-muted-foreground">
                  {pullRequest.author}
                </span>
              ) : null}
            </a>
            {facts.length > 0 ? (
              <p className="px-2 pt-1 text-xs text-muted-foreground">{facts.join(" · ")}</p>
            ) : null}
          </Section>
        </div>
      </div>
    </>
  );
}

/** The selected item in full, beside the list. */
export function WorkDetail({
  selection,
  devinAvatarUrl,
  environmentId,
  projects,
  onClose,
}: {
  readonly selection: WorkSelection;
  readonly devinAvatarUrl: string | undefined;
  readonly environmentId: EnvironmentId | null;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly onClose: () => void;
}) {
  if (selection.kind === "pullRequest") {
    return <PullRequestDetail group={selection.group} onClose={onClose} />;
  }
  if (selection.kind === "work") {
    return <T3WorkDetail group={selection.group} projects={projects} onClose={onClose} />;
  }
  if (environmentId === null) return null;
  if (selection.kind === "conversation") {
    return (
      <SlackDetail
        key={selection.group.id}
        environmentId={environmentId}
        devinAvatarUrl={devinAvatarUrl}
        thread={selection.group.conversation!}
        status={<StatusLine group={selection.group} />}
        group={selection.group}
        cleared={false}
        onClose={onClose}
      />
    );
  }
  return (
    <SlackDetail
      key={`${selection.thread.channelId}:${selection.thread.ts}`}
      environmentId={environmentId}
      devinAvatarUrl={devinAvatarUrl}
      thread={selection.thread}
      status={
        <>
          <WorkStatusDot status="new" />
          <span className="font-medium">New thread</span>
          <span className="truncate text-muted-foreground">
            {selection.cleared ? "cleared" : "not yours yet"}
          </span>
        </>
      }
      group={null}
      cleared={selection.cleared}
      onClose={onClose}
    />
  );
}
