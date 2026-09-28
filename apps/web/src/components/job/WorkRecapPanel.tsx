import { type ComponentProps, useCallback, useEffect, useMemo, useState } from "react";
import type { EnvironmentId, SlackState, WorkCalendarEvent } from "@t3tools/contracts";
import {
  CalendarIcon,
  CheckIcon,
  CopyIcon,
  RefreshCwIcon,
  SparklesIcon,
  StarIcon,
  XIcon,
} from "lucide-react";
import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { useProjects, useServerConfigs, useThreadShells } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { workRecap } from "~/state/workRecap";
import { PullRequestStateGlyph } from "../pullRequest/pullRequestPresentation";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Skeleton } from "../ui/skeleton";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { useWorkCalendar } from "./WorkCalendar";
import {
  includedWorkProjects,
  workItemKeys,
  workItemTitle,
  workMatchesMarks,
  type WorkGroup,
} from "./workGroups";
import {
  SlackChannelGlyph,
  WORK_META_SEPARATOR,
  WorkGroupHeader,
  WorkRow,
  WorkStatusDot,
} from "./workPresentation";
import {
  buildWorkAccomplishments,
  buildWorkPlan,
  localWorkDate,
  type WorkAccomplishment,
  workRecapFacts,
  workRecapWindows,
} from "./workRecap";

type RecapMode = "daily" | "weekly";

function openExternal(url: string) {
  void readLocalApi()?.shell.openExternal(url);
}

function eventTime(event: WorkCalendarEvent) {
  return event.allDay
    ? "All day"
    : new Date(event.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function groupSource(group: WorkGroup): "slack" | "github" | "t3" {
  return group.conversation ? "slack" : group.pullRequest ? "github" : "t3";
}

// Summaries survive closing the dialog; the same recap is never written twice in a session.
const summaryCache = new Map<string, { readonly summary: string; readonly model: string }>();
const summaryInFlight = new Set<string>();

function RecapSummary({
  environmentId,
  mode,
  facts,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly mode: RecapMode;
  readonly facts: string;
}) {
  const summarize = useAtomCommand(workRecap.summarize, { reportFailure: false });
  const key = `${mode}\n${facts}`;
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [, setWritten] = useState(0);
  const result = summaryCache.get(key) ?? null;
  const error = failedKey === key;
  // Anything without a summary or a failure is being written.
  const loading = environmentId !== null && result === null && !error;

  const generate = useCallback(
    async (input: { readonly mode: RecapMode; readonly facts: string }) => {
      const runKey = `${input.mode}\n${input.facts}`;
      if (!environmentId || summaryInFlight.has(runKey)) return;
      summaryInFlight.add(runKey);
      const response = await summarize({ environmentId, input });
      summaryInFlight.delete(runKey);
      if (response._tag === "Success") {
        summaryCache.set(runKey, response.value);
        setWritten((count) => count + 1);
      } else setFailedKey(runKey);
    },
    [environmentId, summarize],
  );

  // A recap that has not been summarized yet (new mode or new work) is written on open.
  useEffect(() => {
    if (!summaryCache.has(`${mode}\n${facts}`)) void generate({ mode, facts });
  }, [mode, facts, generate]);

  function regenerate() {
    summaryCache.delete(key);
    setFailedKey(null);
    void generate({ mode, facts });
  }

  return (
    <section className="rounded-lg border bg-muted/30 p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <SparklesIcon aria-hidden className="size-3.5" />
        <span className="font-medium text-foreground">Summary</span>
        {result && !loading ? <span className="truncate">· {result.model}</span> : null}
        <Button
          className="ml-auto"
          size="icon-micro"
          variant="ghost-muted"
          aria-label="Write the summary again"
          disabled={loading || !environmentId}
          onClick={regenerate}
        >
          <RefreshCwIcon />
        </Button>
      </div>
      <div className="mt-2 text-sm leading-relaxed">
        {!environmentId ? (
          <p className="text-muted-foreground">Connect to an environment to write a summary.</p>
        ) : loading ? (
          <div className="space-y-2 py-1" aria-label="Writing the summary">
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-11/12" />
            <Skeleton className="h-3.5 w-2/3" />
          </div>
        ) : error ? (
          <p role="alert" className="text-destructive">
            The summary could not be written. Check the text generation model in Settings.
          </p>
        ) : result ? (
          <p className="whitespace-pre-line">{result.summary}</p>
        ) : null}
      </div>
    </section>
  );
}

function AccomplishmentRow({
  item,
  highlighted,
  onToggleHighlight,
  onSelect,
}: {
  readonly item: WorkAccomplishment;
  readonly highlighted?: boolean;
  readonly onToggleHighlight?: () => void;
  readonly onSelect: (id: string) => void;
}) {
  const id = item.keys.join("|");
  return (
    <div className="flex items-center gap-1">
      <div className="min-w-0 flex-1">
        <WorkRow
          id={id}
          selected={false}
          glyph={<WorkStatusDot status="done" reason={item.evidence} />}
          source={item.source}
          title={item.title}
          signals={
            item.pullRequest ? (
              <PullRequestStateGlyph
                state={item.pullRequest.state}
                isDraft={item.pullRequest.isDraft}
                className="size-3.5"
              />
            ) : null
          }
          meta={
            <>
              {item.channel ? (
                <span className="inline-flex min-w-0 max-w-40 shrink items-center gap-1">
                  <SlackChannelGlyph kind={item.channel.kind} />
                  <span className="truncate">{item.channel.name}</span>
                </span>
              ) : item.pullRequest ? (
                <span className="min-w-0 max-w-48 truncate font-mono">
                  {item.pullRequest.label}
                </span>
              ) : null}
              {item.channel || item.pullRequest ? WORK_META_SEPARATOR : null}
              <span className="min-w-0 truncate">{item.evidence}</span>
            </>
          }
          updatedAt={new Date(item.at).toISOString()}
          onSelect={() =>
            item.groupId ? onSelect(item.groupId) : item.url && openExternal(item.url)
          }
        />
      </div>
      {onToggleHighlight ? (
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-pressed={highlighted}
          aria-label={highlighted ? "Remove from the demo" : "Show in the demo"}
          onClick={onToggleHighlight}
        >
          <StarIcon className={cn(highlighted && "fill-warning text-warning")} />
        </Button>
      ) : null}
    </div>
  );
}

export function WorkRecapPanel({
  environmentId,
  groups,
  slack,
  onSelect,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly groups: ReadonlyArray<WorkGroup>;
  readonly slack: SlackState | null;
  readonly onSelect: (id: string) => void;
}) {
  const settings = usePrimarySettings();
  const update = useUpdatePrimarySettings();
  const threads = useThreadShells();
  const projects = useProjects();
  const configs = useServerConfigs();
  const minute = useNowMinute();
  const now = new Date(`${minute}:00Z`);
  const date = localWorkDate(now);
  const { today, lastWorkday } = workRecapWindows(now);
  const [mode, setMode] = useState<RecapMode>("daily");
  const [copied, setCopied] = useState(false);
  const calendar = useWorkCalendar(environmentId);
  const ignored = settings.workIgnoredItems ?? [];
  const highlights = settings.workDemoHighlights ?? [];

  const accomplishments = useMemo(() => {
    const included = new Set(
      includedWorkProjects(projects, configs).map(
        (project) => `${project.environmentId}:${project.id}`,
      ),
    );
    return buildWorkAccomplishments({
      groups,
      threads: threads.filter((thread) =>
        included.has(`${thread.environmentId}:${thread.projectId}`),
      ),
      slack,
      ignored: settings.workIgnoredItems ?? [],
      githubOwners: settings.workGitHubOwners,
      since: workRecapWindows(new Date(`${minute}:00Z`)).week,
      now: Date.parse(`${minute}:59Z`),
    });
  }, [
    groups,
    threads,
    projects,
    configs,
    slack,
    settings.workIgnoredItems,
    settings.workGitHubOwners,
    minute,
  ]);

  const completed =
    mode === "daily"
      ? accomplishments.filter((item) => item.at >= lastWorkday && item.at < today)
      : accomplishments;
  const period =
    mode === "weekly"
      ? now.getDay() === 1
        ? "since last Monday"
        : "this week"
      : today - lastWorkday <= 86_400_000 * 1.5
        ? "yesterday"
        : `since ${new Date(lastWorkday).toLocaleDateString([], { weekday: "long" })}`;

  // Grouped by project, busiest first, so the list reads as areas of work.
  const sections = new Map<string, WorkAccomplishment[]>();
  for (const item of completed) {
    const title =
      (item.project &&
        projects.find(
          (project) =>
            project.environmentId === item.project!.environmentId &&
            project.id === item.project!.projectId,
        )?.title) ||
      (item.source === "slack" ? "Slack" : item.source === "github" ? "GitHub" : "Other");
    sections.set(title, [...(sections.get(title) ?? []), item]);
  }
  const sectionEntries = [...sections].toSorted(([, a], [, b]) => b.length - a.length);

  const planned = buildWorkPlan(
    settings.workDayPlan?.date === date ? settings.workDayPlan.items : [],
    groups,
    ignored,
  );
  const plannedGroups = planned.map((item) => ({
    item,
    group: groups.find((candidate) => workMatchesMarks(workItemKeys(candidate), [item])),
  }));
  const waiting = groups.filter(
    (group) =>
      group.status === "waiting" &&
      group.owner === null &&
      !workMatchesMarks(workItemKeys(group), ignored),
  );
  const events = calendar.result?.connected ? calendar.result.events : [];

  const facts = workRecapFacts({
    period,
    sections: sectionEntries,
    highlights: mode === "weekly" ? highlights : [],
    planned: mode === "daily" ? planned.map((item) => item.title) : [],
    meetings: mode === "daily" ? events.map((event) => `${eventTime(event)} ${event.title}`) : [],
    waiting:
      mode === "daily"
        ? waiting.map(
            (group) => `${workItemTitle(group)}${group.reason ? ` (${group.reason})` : ""}`,
          )
        : [],
  });

  async function copy() {
    const summary = summaryCache.get(`${mode}\n${facts}`)?.summary;
    const lines = [
      mode === "daily" ? `Standup · ${period}` : `Weekly demo · ${period}`,
      ...(summary ? ["", summary] : []),
      "",
      ...sectionEntries.flatMap(([title, items]) => [
        title,
        ...items.map(
          (item) =>
            `${workMatchesMarks(item.keys, highlights) && mode === "weekly" ? "★" : "•"} ${item.title}${item.url ? ` ${item.url}` : ""}`,
        ),
        "",
      ]),
      ...(mode === "daily" && planned.length > 0
        ? ["Today", ...planned.map((item) => `• ${item.title}`), ""]
        : []),
    ];
    await navigator.clipboard.writeText(lines.join("\n").trim()).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const shippedCount = completed.length;
  const mergedCount = completed.filter((item) => item.pullRequest?.state === "merged").length;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <ToggleGroup
          aria-label="Recap"
          value={[mode]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "daily" || value === "weekly") setMode(value);
          }}
        >
          <Toggle value="daily">Daily standup</Toggle>
          <Toggle value="weekly">Weekly demo</Toggle>
        </ToggleGroup>
        <Button className="ml-auto" size="sm" variant="outline" onClick={() => void copy()}>
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>

      <RecapSummary environmentId={environmentId} mode={mode} facts={facts} />

      <div className="-mx-3 space-y-4">
        <div className="space-y-1">
          <WorkGroupHeader
            label={`Done ${period}`}
            count={shippedCount}
            action={
              mergedCount > 0 ? (
                <span className="shrink-0">
                  {mergedCount} merged {mergedCount === 1 ? "PR" : "PRs"}
                </span>
              ) : undefined
            }
          />
          {shippedCount === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              Nothing finished {period}. Work counts once a thread changes files, a PR merges, or
              you mark your own conversation done.
            </p>
          ) : null}
        </div>
        {sectionEntries.map(([title, items]) => (
          <div key={title} className="space-y-0.5">
            <div className="px-3 pb-0.5 text-2xs font-medium text-muted-foreground/70">{title}</div>
            {items.map((item) => (
              <AccomplishmentRow
                key={item.keys.join("|")}
                item={item}
                onSelect={onSelect}
                {...(mode === "weekly"
                  ? {
                      highlighted: workMatchesMarks(item.keys, highlights),
                      onToggleHighlight: () =>
                        update({
                          workDemoHighlights: workMatchesMarks(item.keys, highlights)
                            ? highlights.filter((mark) => !workMatchesMarks(item.keys, [mark]))
                            : [...highlights, { keys: item.keys, title: item.title, at: item.at }],
                        }),
                    }
                  : {})}
              />
            ))}
          </div>
        ))}

        {mode === "daily" ? (
          <>
            <div className="space-y-0.5">
              <WorkGroupHeader label="Planned today" count={planned.length} />
              {plannedGroups.length === 0 ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">
                  Open a work item and choose “Plan for today”.
                </p>
              ) : (
                plannedGroups.map(({ item, group }, index) => (
                  <div key={item.keys.join("|")} className="flex items-center gap-1">
                    <div className="min-w-0 flex-1">
                      <WorkRow
                        id={group?.id ?? item.keys.join("|")}
                        selected={false}
                        glyph={
                          <WorkStatusDot
                            status={group?.status ?? "new"}
                            reason={group?.reason ?? "Planned"}
                          />
                        }
                        source={group ? groupSource(group) : "t3"}
                        title={item.title}
                        meta={
                          <span className="min-w-0 truncate">{group?.reason ?? "Planned"}</span>
                        }
                        updatedAt={group?.updatedAt ?? new Date(item.at).toISOString()}
                        onSelect={() => group && onSelect(group.id)}
                      />
                    </div>
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label="Remove from today's plan"
                      onClick={() =>
                        update({
                          workDayPlan: { date, items: planned.filter((_, i) => i !== index) },
                        })
                      }
                    >
                      <XIcon />
                    </Button>
                  </div>
                ))
              )}
            </div>

            <div className="space-y-0.5">
              <WorkGroupHeader
                label="Meetings"
                count={events.length}
                action={
                  <Button
                    size="icon-micro"
                    variant="ghost-muted"
                    aria-label="Refresh calendar"
                    disabled={calendar.loading}
                    onClick={() => void calendar.refresh()}
                  >
                    <RefreshCwIcon />
                  </Button>
                }
              />
              {calendar.error ? (
                <p role="alert" className="px-3 py-2 text-sm text-destructive">
                  {calendar.error}
                </p>
              ) : !calendar.loading && !calendar.result?.connected ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">
                  Connect Google Calendar in Settings → Work.
                </p>
              ) : events.length === 0 && !calendar.loading ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">No meetings today.</p>
              ) : (
                events.map((event) => (
                  <div key={event.id} className="flex items-start gap-2 px-3 py-1.5">
                    <CalendarIcon
                      aria-hidden
                      className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                    />
                    <span className="w-16 shrink-0 text-xs tabular-nums text-muted-foreground">
                      {eventTime(event)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{event.title}</span>
                      {event.location ? (
                        <span className="block truncate text-2xs text-muted-foreground">
                          {event.location}
                        </span>
                      ) : null}
                    </span>
                  </div>
                ))
              )}
            </div>

            {waiting.length > 0 ? (
              <div className="space-y-0.5">
                <WorkGroupHeader label="Waiting on others" count={waiting.length} />
                {waiting.map((group) => (
                  <WorkRow
                    key={group.id}
                    id={group.id}
                    selected={false}
                    glyph={<WorkStatusDot status="waiting" reason={group.reason} />}
                    source={groupSource(group)}
                    title={workItemTitle(group)}
                    meta={
                      group.conversation ? (
                        <>
                          <span className="inline-flex min-w-0 max-w-40 shrink items-center gap-1">
                            <SlackChannelGlyph kind={group.conversation.channelKind} />
                            <span className="truncate">{group.conversation.channelName}</span>
                          </span>
                          {WORK_META_SEPARATOR}
                          <span className="min-w-0 truncate">{group.reason}</span>
                        </>
                      ) : (
                        <span className="min-w-0 truncate">{group.reason}</span>
                      )
                    }
                    updatedAt={group.updatedAt}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <p className="px-3 text-xs text-muted-foreground">
            Star what you want to show. Starred work leads the summary and the copied text.
          </p>
        )}
      </div>
    </div>
  );
}

export function WorkRecapDialog({
  open,
  onOpenChange,
  ...props
}: ComponentProps<typeof WorkRecapPanel> & {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Recap</DialogTitle>
          <DialogDescription>
            Your standup and weekly demo, written from your work.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>{open ? <WorkRecapPanel {...props} /> : null}</DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
