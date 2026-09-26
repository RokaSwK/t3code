import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useNavigate } from "@tanstack/react-router";
import { ExternalLinkIcon, MessageSquareIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useOpenLink } from "../../browser/useOpenLink";
import { useOpenPrLink } from "../../lib/openPullRequestLink";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../../state/entities";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import {
  buildWorkGroups,
  type WorkGroup,
  type WorkPullRequest,
  type WorkStatus,
} from "./workGroups";

const STATUS_LABELS: Record<WorkStatus, string> = {
  needs: "Needs me",
  working: "In progress",
  waiting: "Waiting",
  done: "Done",
};

const FILTERS: ReadonlyArray<{ readonly key: WorkStatus | "all"; readonly label: string }> = [
  { key: "all", label: "All" },
  { key: "needs", label: "Needs me" },
  { key: "working", label: "In progress" },
  { key: "waiting", label: "Waiting" },
  { key: "done", label: "Done" },
];

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

function WorkCard({
  group,
  projects,
}: {
  readonly group: WorkGroup;
  readonly projects: ReadonlyArray<EnvironmentProject>;
}) {
  const navigate = useNavigate();
  const primary = group.threads[0]!;
  const threadRef = { environmentId: primary.environmentId, threadId: primary.id };
  const openPrLink = useOpenPrLink(threadRef);
  const openLink = useOpenLink(threadRef);
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
            {group.reason} · updated {formatRelativeTimeLabel(group.updatedAt)}
          </p>
        </div>
        <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {STATUS_LABELS[group.status]}
        </span>
      </div>
      {group.pullRequests.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {group.pullRequests.map((request) => (
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
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {group.threads.map((thread) => (
          <Button
            key={`${thread.environmentId}:${thread.id}`}
            size="xs"
            variant="outline"
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId: thread.environmentId, threadId: thread.id },
              })
            }
          >
            <MessageSquareIcon />
            <span className="max-w-40 truncate">{thread.title}</span>
          </Button>
        ))}
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

/** Current work across connected environments, grouped by shared PR and Slack links. */
export function WorkOverview() {
  const shells = useThreadShells();
  const projects = useProjects();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const [filter, setFilter] = useState<WorkStatus | "all">("needs");
  const [limit, setLimit] = useState(30);
  const groups = useMemo(() => buildWorkGroups(shells), [shells]);
  const counts = useMemo(
    () => ({
      all: groups.length,
      needs: groups.filter((group) => group.status === "needs").length,
      working: groups.filter((group) => group.status === "working").length,
      waiting: groups.filter((group) => group.status === "waiting").length,
      done: groups.filter((group) => group.status === "done").length,
    }),
    [groups],
  );
  const visible = useMemo(
    () =>
      groups
        .filter((group) => filter === "all" || group.status === filter)
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [filter, groups],
  );

  return (
    <section className="flex flex-col gap-3" aria-label="Linked work">
      <div>
        <h2 className="text-sm font-medium">Linked work</h2>
        <p className="text-xs text-muted-foreground">
          Agent threads, pull requests, and Slack conversations connected to the same work.
        </p>
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
              setLimit(30);
            }}
          >
            {label} {counts[key]}
          </Button>
        ))}
      </div>
      {!bootstrapped ? (
        <p className="text-sm text-muted-foreground">Loading work from your environments…</p>
      ) : null}
      {visible.length === 0 && bootstrapped ? (
        <p className="text-sm text-muted-foreground">
          {filter === "needs" ? "Nothing needs your attention right now." : "No work in this view."}
        </p>
      ) : visible.length > 0 ? (
        <>
          <div className="flex flex-col gap-2">
            {visible.slice(0, limit).map((group) => (
              <WorkCard key={group.id} group={group} projects={projects} />
            ))}
          </div>
          {visible.length > limit ? (
            <Button size="sm" variant="outline" onClick={() => setLimit((current) => current + 30)}>
              Show more
            </Button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
