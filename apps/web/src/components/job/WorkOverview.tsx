import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { DevinSessionState, EnvironmentId, SlackState } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { BotIcon, ExternalLinkIcon, MessageSquareIcon, MessageSquarePlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useOpenLink } from "../../browser/useOpenLink";
import { useOpenPrLink } from "../../lib/openPullRequestLink";
import { readLocalApi } from "../../localApi";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useServerConfigs,
  useThreadShells,
} from "../../state/entities";
import { slackEnvironment } from "../../state/slack";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SlackThreadItem } from "./SlackThreadItem";
import { StartThreadFromSlackDialog } from "./StartThreadFromSlackDialog";
import { WorkAgentButton } from "./WorkAgentButton";
import {
  buildWorkGroups,
  type WorkGroup,
  type WorkPullRequest,
  type WorkStatus,
  type WorkThread,
} from "./workGroups";
import { includedWorkProjects, workRootsForEnvironment } from "./workScope";
import { WorkScopeDialog } from "./WorkScopeDialog";

const STATUS_LABELS: Record<WorkStatus, string> = {
  needs: "Needs me",
  working: "In progress",
  waiting: "Waiting",
  done: "Done",
};

const STATUS_BADGES = {
  needs: "warning",
  working: "info",
  waiting: "secondary",
  done: "success",
} as const;

const FILTERS: ReadonlyArray<{ readonly key: WorkStatus | "all"; readonly label: string }> = [
  { key: "all", label: "All" },
  { key: "needs", label: "Needs me" },
  { key: "working", label: "In progress" },
  { key: "waiting", label: "Waiting" },
  { key: "done", label: "Done" },
];

const DEVIN_STATE_LABELS: Record<DevinSessionState, string> = {
  working: "working",
  waiting: "waiting for you",
  finished: "finished",
  suspended: "asleep",
  error: "stopped",
};

const PAGE_SIZE = 30;

function openExternal(url: string) {
  void readLocalApi()?.shell.openExternal(url);
}

function prStatus(request: WorkPullRequest): string {
  const snapshot = request.snapshot;
  if (snapshot === null) return "Status pending";
  if (snapshot.state !== "open") return snapshot.state === "merged" ? "Merged" : "Closed";
  const labels = [snapshot.isDraft ? "Draft" : "Open"];
  if (snapshot.checksState === "passing") labels.push("checks passing");
  if (snapshot.checksState === "failing") labels.push("checks failing");
  if (snapshot.checksState === "pending") labels.push("checks running");
  if (snapshot.reviewDecision === "approved") labels.push("approved");
  if (snapshot.reviewDecision === "changes-requested") labels.push("changes requested");
  if (snapshot.reviewDecision === "review-required") labels.push("review required");
  if (snapshot.mergeability === "conflicting") labels.push("merge conflict");
  return labels.join(" · ");
}

function StatusBadge({ group }: { readonly group: WorkGroup }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Badge variant={STATUS_BADGES[group.status]} size="sm">
        {STATUS_LABELS[group.status]}
      </Badge>
      <span className="truncate">{group.reason}</span>
    </span>
  );
}

/** PRs from T3 threads, with the checks and review state GitHub last reported. */
function PullRequestChips({ requests }: { readonly requests: ReadonlyArray<WorkPullRequest> }) {
  const openPrLink = useOpenPrLink(requests[0]!.threadRef);
  return (
    <div className="flex flex-wrap gap-2">
      {requests.map((request) => (
        <a
          key={request.key}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
          href={request.url}
          rel="noreferrer"
          target="_blank"
          onClick={(event) => openPrLink(event, request.url, request.threadRef)}
        >
          <PullRequestGlyph.pullRequest className="size-3.5" />
          <span className="max-w-48 truncate">
            {request.repository}#{request.number}
          </span>
          {request.snapshot ? (
            <span className="max-w-40 truncate">{request.snapshot.title}</span>
          ) : null}
          <span className="text-muted-foreground">{prStatus(request)}</span>
          {request.snapshot ? (
            <span className="text-muted-foreground">
              · synced {formatRelativeTimeLabel(request.snapshot.syncedAt)}
            </span>
          ) : null}
        </a>
      ))}
    </div>
  );
}

function ThreadButtons({ threads }: { readonly threads: ReadonlyArray<WorkThread> }) {
  const navigate = useNavigate();
  return threads.map((thread) => (
    <InlineButton
      key={`${thread.environmentId}:${thread.id}`}
      tone="muted"
      className="max-w-64"
      onClick={() =>
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: thread.environmentId, threadId: thread.id },
        })
      }
    >
      <MessageSquareIcon />
      <span className="truncate">{thread.title}</span>
    </InlineButton>
  ));
}

/** One of your Slack conversations, with the agents and PRs working on it. */
function ConversationCard({
  group,
  environmentId,
}: {
  readonly group: WorkGroup;
  readonly environmentId: EnvironmentId;
}) {
  const conversation = group.conversation!;
  const setDismissed = useAtomCommand(slackEnvironment.setDismissed, { reportFailure: false });
  const unfollow = useAtomCommand(slackEnvironment.unfollow, { reportFailure: false });
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const slackPullRequests = new Set(conversation.pullRequests?.map((request) => request.url));
  const threadPullRequests = group.pullRequests.filter(
    (request) => !slackPullRequests.has(request.url),
  );
  const sessions = conversation.devin?.sessions ?? [];
  const run = (action: () => Promise<{ readonly _tag: string }>, failure: string) => {
    setBusy(true);
    void action().then((result) => {
      setBusy(false);
      if (result._tag === "Failure") toastManager.add({ type: "error", title: failure });
    });
  };
  const ref = { channelId: conversation.channelId, ts: conversation.ts };
  return (
    <SlackThreadItem
      environmentId={environmentId}
      thread={conversation}
      badge={<StatusBadge group={group} />}
      footer={
        <div className="flex min-w-0 flex-col gap-2 ps-11">
          {sessions.length > 0 || group.threads.length > 0 ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {sessions.map((session) => (
                <InlineButton
                  key={session.id}
                  tone="muted"
                  className="max-w-72"
                  onClick={() => openExternal(session.url)}
                >
                  <BotIcon />
                  <span className="truncate">
                    Devin
                    {session.state ? ` · ${DEVIN_STATE_LABELS[session.state]}` : ""}
                    {session.title ? ` · ${session.title}` : ""}
                  </span>
                </InlineButton>
              ))}
              <ThreadButtons threads={group.threads} />
            </div>
          ) : null}
          {threadPullRequests.length > 0 ? (
            <PullRequestChips requests={threadPullRequests} />
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="xs" variant="outline" onClick={() => setPicking(true)}>
              <MessageSquarePlusIcon />
              {group.threads.length > 0 ? "Start another thread" : "Start thread"}
            </Button>
            {group.markedDone ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  run(
                    () => setDismissed({ environmentId, input: { ...ref, dismissed: false } }),
                    "Could not update the conversation",
                  )
                }
              >
                Not done
              </Button>
            ) : group.status !== "done" ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  run(
                    () => setDismissed({ environmentId, input: { ...ref, dismissed: true } }),
                    "Could not update the conversation",
                  )
                }
              >
                Done
              </Button>
            ) : null}
            {conversation.followed ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  run(() => unfollow({ environmentId, input: ref }), "Could not unfollow thread")
                }
              >
                Unfollow
              </Button>
            ) : null}
          </div>
          {picking ? (
            <StartThreadFromSlackDialog
              environmentId={environmentId}
              thread={conversation}
              onOpenChange={setPicking}
            />
          ) : null}
        </div>
      }
    />
  );
}

/** T3 work with no Slack conversation of yours behind it. */
function WorkCard({
  group,
  projects,
}: {
  readonly group: WorkGroup;
  readonly projects: ReadonlyArray<EnvironmentProject>;
}) {
  const primary = group.threads[0]!;
  const openLink = useOpenLink({ environmentId: primary.environmentId, threadId: primary.id });
  const project = projects.find(
    (candidate) =>
      candidate.environmentId === primary.environmentId && candidate.id === primary.projectId,
  );
  return (
    <article className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">{primary.title}</h3>
          <p className="text-xs text-muted-foreground">
            {project?.title ? `${project.title} · ` : ""}
            updated {formatRelativeTimeLabel(group.updatedAt)}
          </p>
        </div>
        <span className="text-xs text-muted-foreground">
          <StatusBadge group={group} />
        </span>
      </div>
      {group.pullRequests.length > 0 ? (
        <div className="mt-3">
          <PullRequestChips requests={group.pullRequests} />
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <ThreadButtons threads={group.threads} />
        {group.slackLinks.map((url, index) => (
          <Button
            key={url}
            size="xs"
            variant="ghost"
            onClick={() =>
              void openLink(url).catch(() => {
                toastManager.add({ type: "error", title: "Could not open Slack thread" });
              })
            }
          >
            <ExternalLinkIcon />
            Slack{group.slackLinks.length > 1 ? ` ${index + 1}` : ""}
          </Button>
        ))}
      </div>
    </article>
  );
}

const byStatusThenRecent = (filter: WorkStatus | "all") => (groups: ReadonlyArray<WorkGroup>) =>
  groups
    .filter((group) => filter === "all" || group.status === filter)
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));

/**
 * Your work: Slack conversations that are yours (👀, Devin threads you are in, and threads
 * linked from T3), each with the T3 threads, Devin sessions, and PRs working on it. T3 work
 * with no conversation behind it follows, scoped by Folders.
 */
export function WorkOverview({
  slackState,
  environmentId,
}: {
  readonly slackState: SlackState | null;
  readonly environmentId: EnvironmentId | null;
}) {
  const shells = useThreadShells();
  const projects = useProjects();
  const configs = useServerConfigs();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const [filter, setFilter] = useState<WorkStatus | "all">("needs");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [otherOpen, setOtherOpen] = useState(false);
  const [choosingFolders, setChoosingFolders] = useState(false);
  const connection = slackState?.connection;
  const slackConnected =
    connection?.status === "connected" ||
    (connection?.status === "authorizing" && connection.connectedAs !== undefined);
  const includedProjects = useMemo(
    () => includedWorkProjects(projects, configs),
    [projects, configs],
  );
  const agentRoot = useMemo(() => {
    const roots = [...new Set(projects.map((project) => project.environmentId))].flatMap((id) =>
      workRootsForEnvironment(projects, id, configs.get(id)),
    );
    return roots.find((project) => project.environmentId === environmentId) ?? roots[0] ?? null;
  }, [projects, configs, environmentId]);
  const conversations = slackConnected ? slackState!.conversations : undefined;
  const dismissed = slackState?.dismissed;
  const groups = useMemo(
    () =>
      buildWorkGroups(shells, {
        ...(conversations ? { conversations } : {}),
        ...(dismissed ? { dismissed } : {}),
      }),
    [shells, conversations, dismissed],
  );
  const { mine, other } = useMemo(() => {
    const included = new Set(
      includedProjects.map((project) => `${project.environmentId}:${project.id}`),
    );
    return {
      mine: groups.filter((group) => group.conversation !== null),
      other: groups.filter(
        (group) =>
          group.conversation === null &&
          group.threads.some((thread) =>
            included.has(`${thread.environmentId}:${thread.projectId}`),
          ),
      ),
    };
  }, [groups, includedProjects]);
  const counts = useMemo(() => {
    const all = [...mine, ...other];
    return {
      all: all.length,
      needs: all.filter((group) => group.status === "needs").length,
      working: all.filter((group) => group.status === "working").length,
      waiting: all.filter((group) => group.status === "waiting").length,
      done: all.filter((group) => group.status === "done").length,
    };
  }, [mine, other]);
  const visibleMine = useMemo(() => byStatusThenRecent(filter)(mine), [filter, mine]);
  const visibleOther = useMemo(() => byStatusThenRecent(filter)(other), [filter, other]);
  // Without Slack, T3 work is all there is, so it starts open.
  const showOther = otherOpen || !slackConnected;

  return (
    <section className="flex flex-col gap-3" aria-label="Your work">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium">Your work</h2>
          <p className="text-xs text-muted-foreground">
            Slack conversations you follow with 👀 or work on with Devin, with their T3 threads and
            pull requests.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <WorkAgentButton root={agentRoot} groups={[...mine, ...other]} projects={projects} />
          <Button size="xs" variant="ghost" onClick={() => setChoosingFolders(true)}>
            Folders
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-1" aria-label="Work status">
        {FILTERS.map(({ key, label }) => (
          <Button
            key={key}
            size="xs"
            variant={filter === key ? "secondary" : "ghost"}
            aria-pressed={filter === key}
            onClick={() => {
              setFilter(key);
              setLimit(PAGE_SIZE);
            }}
          >
            {label} {counts[key]}
          </Button>
        ))}
      </div>
      {!slackConnected ? (
        slackState === null ? null : (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-border p-3">
            <p className="text-sm text-muted-foreground">
              Connect Slack to see your conversations and Devin sessions here.
            </p>
            <Button size="xs" variant="outline" render={<Link to="/settings/work" />}>
              Set up in Settings
            </Button>
          </div>
        )
      ) : visibleMine.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {filter === "needs"
            ? "No conversation needs you right now."
            : "No conversations in this view."}
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-3">
            {visibleMine.slice(0, limit).map((group) => (
              <ConversationCard key={group.id} group={group} environmentId={environmentId!} />
            ))}
          </div>
          {visibleMine.length > limit ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setLimit((current) => current + PAGE_SIZE)}
            >
              Show more
            </Button>
          ) : null}
        </>
      )}
      <div className="flex flex-col gap-2 pt-1">
        {slackConnected ? (
          <div>
            <Button size="xs" variant="ghost" onClick={() => setOtherOpen(!otherOpen)}>
              {otherOpen ? "Hide" : "Show"} other work ({visibleOther.length})
            </Button>
          </div>
        ) : null}
        {showOther ? (
          !bootstrapped ? (
            <p className="text-sm text-muted-foreground">Loading work from your environments…</p>
          ) : includedProjects.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Choose Folders to show T3 work that is not tied to a Slack conversation.
            </p>
          ) : visibleOther.length === 0 ? (
            <p className="text-sm text-muted-foreground">No other work in this view.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {visibleOther.slice(0, PAGE_SIZE).map((group) => (
                <WorkCard key={group.id} group={group} projects={projects} />
              ))}
            </div>
          )
        ) : null}
      </div>
      <WorkScopeDialog
        open={choosingFolders}
        onOpenChange={setChoosingFolders}
        projects={projects}
        configs={configs}
      />
    </section>
  );
}
