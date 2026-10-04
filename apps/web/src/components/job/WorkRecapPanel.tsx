import { type ComponentProps, type ReactNode, useCallback, useEffect, useState } from "react";
import type {
  EnvironmentId,
  WorkCalendarEvent,
  WorkItemMark,
  WorkRecapInput,
  WorkRecapItem,
  WorkRecapView,
} from "@t3tools/contracts";
import {
  buildWorkPlan,
  recapWaitingGroups,
  workGroupTitle,
  workRecapFeatureSize,
} from "@t3tools/shared/workRecap";
import {
  CalendarIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  RefreshCwIcon,
  SlackIcon,
  SparklesIcon,
  StarIcon,
  XIcon,
} from "lucide-react";
import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { useAtomCommand } from "~/state/use-atom-command";
import { workRecap } from "~/state/workRecap";
import { PullRequestStateGlyph } from "../pullRequest/pullRequestPresentation";
import { GitHubIcon } from "../Icons";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
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
import { workItemKeys, workMatchesMarks, type WorkGroup } from "./workGroups";
import {
  SlackChannelGlyph,
  T3Logo,
  WORK_META_SEPARATOR,
  WorkGroupHeader,
  WorkRow,
  WorkStatusDot,
} from "./workPresentation";
import { localWorkDate, workRecapWindows } from "./workRecap";

type RecapMode = "daily" | "weekly";

/** A feature card: the server's feature, or the work it has not grouped yet. */
interface RecapClusterView {
  readonly title: string;
  readonly description: string | null;
  readonly items: ReadonlyArray<WorkRecapItem>;
  readonly area: string | null;
  readonly minor: boolean;
}

/** Biggest feature first; the size of an area is the size of all its items together. */
function bySize(clusters: ReadonlyArray<RecapClusterView>) {
  return clusters
    .map((cluster) => ({ cluster, size: workRecapFeatureSize(cluster.items) }))
    .toSorted((a, b) => b.size - a.size)
    .map(({ cluster }) => cluster);
}

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

// The last view per recap survives closing the dialog, so reopening shows it at once.
const lastViews = new Map<string, WorkRecapView>();

/**
 * The server's recap for this window: read what it has first, which is instant, then ask it to
 * group new work and write a missing summary, which waits on the text generation model.
 */
function useWorkRecap(
  environmentId: EnvironmentId | null,
  input: Omit<WorkRecapInput, "write" | "regroup">,
  ready: boolean,
) {
  const run = useAtomCommand(workRecap.recap, { reportFailure: false });
  // The key is the request: a new window, mode, or meeting list is a new recap.
  const key = JSON.stringify([environmentId, input]);
  const [, setVersion] = useState(0);
  const [writingKey, setWritingKey] = useState<string | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);

  const request = useCallback(
    async (requestKey: string, write: boolean, regroup: boolean) => {
      const [requestEnvironment, requestInput] = JSON.parse(requestKey) as [
        EnvironmentId | null,
        Omit<WorkRecapInput, "write" | "regroup">,
      ];
      if (!requestEnvironment) return null;
      if (write) setWritingKey(requestKey);
      const response = await run({
        environmentId: requestEnvironment,
        input: { ...requestInput, write, ...(regroup ? { regroup: true } : {}) },
      });
      if (write) setWritingKey((current) => (current === requestKey ? null : current));
      if (response._tag !== "Success") {
        setFailedKey(requestKey);
        return null;
      }
      lastViews.set(requestKey, response.value);
      setVersion((version) => version + 1);
      return response.value;
    },
    [run],
  );

  useEffect(() => {
    if (!ready) return;
    void (async () => {
      const view = await request(key, false, false);
      if (view?.stale) await request(key, true, false);
    })();
  }, [key, ready, request]);

  return {
    view: lastViews.get(key) ?? null,
    writing: writingKey === key,
    failed: failedKey === key,
    regroup: () => {
      setFailedKey(null);
      void request(key, true, true);
    },
  };
}

function RecapSummaryCard({
  environmentId,
  recap,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly recap: ReturnType<typeof useWorkRecap>;
}) {
  const summary = recap.view?.summary ?? null;
  const loading = environmentId !== null && !summary && !recap.failed;
  return (
    <section className="rounded-lg border bg-muted/30 p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <SparklesIcon aria-hidden className="size-3.5" />
        <span className="font-medium text-foreground">Summary</span>
        {summary ? <span className="truncate">· {summary.model}</span> : null}
        <Button
          className="ml-auto"
          size="icon-micro"
          variant="ghost-muted"
          aria-label="Group this work again and rewrite the summary"
          disabled={recap.writing || !environmentId}
          onClick={recap.regroup}
        >
          <RefreshCwIcon />
        </Button>
      </div>
      <div className="mt-2 text-sm leading-relaxed">
        {!environmentId ? (
          <p className="text-muted-foreground">Connect to an environment to write a summary.</p>
        ) : recap.failed && !summary ? (
          <p role="alert" className="text-destructive">
            The recap could not be written. Check the text generation model in Settings.
          </p>
        ) : loading ? (
          <div className="space-y-2 py-1" aria-label="Writing the summary">
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-11/12" />
            <Skeleton className="h-3.5 w-2/3" />
          </div>
        ) : summary ? (
          <p className="whitespace-pre-line">{summary.text}</p>
        ) : null}
      </div>
    </section>
  );
}

const SOURCE_ORDER = ["github", "t3", "slack"] as const;

/** Which sources a cluster draws from, as logos with counts. */
function ClusterSources({ items }: { readonly items: ReadonlyArray<WorkRecapItem> }) {
  // The header already counts items; per-source counts only help when sources mix.
  const mixed = new Set(items.map((item) => item.source)).size > 1;
  return (
    <span className="flex shrink-0 items-center gap-2 text-2xs tabular-nums text-muted-foreground">
      {SOURCE_ORDER.map((source) => {
        const count = items.filter((item) => item.source === source).length;
        if (count === 0) return null;
        const label =
          source === "github"
            ? "pull requests"
            : source === "slack"
              ? "Slack conversations"
              : "T3 threads";
        return (
          <span
            key={source}
            className="inline-flex items-center gap-0.5"
            aria-label={`${count} ${label}`}
          >
            {source === "github" ? (
              <GitHubIcon aria-hidden className="size-3" />
            ) : source === "slack" ? (
              <SlackIcon aria-hidden className="size-3" />
            ) : (
              <T3Logo />
            )}
            {mixed ? count : null}
          </span>
        );
      })}
    </span>
  );
}

function RecapCluster({
  cluster,
  highlights,
  renderRow,
}: {
  readonly cluster: RecapClusterView;
  readonly highlights: ReadonlyArray<WorkItemMark> | null;
  readonly renderRow: (item: WorkRecapItem, compact: boolean) => ReactNode;
}) {
  const repositories = new Set(
    cluster.items.map((item) => item.pullRequest?.label.split("#")[0] ?? null),
  );
  const compact = repositories.size === 1 && !repositories.has(null);
  const starred = highlights
    ? cluster.items.filter((item) => workMatchesMarks(item.keys, highlights)).length
    : 0;
  return (
    <div className="rounded-lg border">
      <Collapsible>
        <CollapsibleTrigger className="group flex w-full items-start gap-2 rounded-lg px-3 py-2.5 text-left hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <ChevronRightIcon
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90"
          />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate text-sm font-medium">{cluster.title}</span>
              <span className="shrink-0 rounded-full bg-muted px-1.5 text-2xs tabular-nums text-muted-foreground">
                {cluster.items.length}
              </span>
              {starred > 0 ? (
                <StarIcon
                  aria-label={`${starred} starred`}
                  className="size-3 shrink-0 fill-warning text-warning"
                />
              ) : null}
              <span className="ml-auto">
                <ClusterSources items={cluster.items} />
              </span>
            </span>
            {cluster.description ? (
              <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
                {cluster.description}
              </span>
            ) : null}
          </span>
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="space-y-0.5 border-t p-1">
            {cluster.items.map((item) => renderRow(item, compact))}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

function AccomplishmentRow({
  item,
  compact = false,
  highlighted,
  onToggleHighlight,
  onSelect,
}: {
  readonly item: WorkRecapItem;
  /** Inside a card of one repository: show `#123` and let the merged glyph speak. */
  readonly compact?: boolean;
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
                  {compact
                    ? `#${item.pullRequest.label.split("#").at(-1)}`
                    : item.pullRequest.label}
                </span>
              ) : null}
              {compact && item.evidence === "PR merged" ? null : (
                <>
                  {item.channel || item.pullRequest ? WORK_META_SEPARATOR : null}
                  <span className="min-w-0 truncate">{item.evidence}</span>
                </>
              )}
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
  onSelect,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly groups: ReadonlyArray<WorkGroup>;
  readonly onSelect: (id: string) => void;
}) {
  const settings = usePrimarySettings();
  const update = useUpdatePrimarySettings();
  const minute = useNowMinute();
  const now = new Date(`${minute}:00Z`);
  const date = localWorkDate(now);
  const { today, lastWorkday, week } = workRecapWindows(now);
  const startOfDay = new Date(today);
  const tomorrow = new Date(
    startOfDay.getFullYear(),
    startOfDay.getMonth(),
    startOfDay.getDate() + 1,
  ).getTime();
  const [mode, setMode] = useState<RecapMode>("daily");
  const [copied, setCopied] = useState(false);
  const calendar = useWorkCalendar(environmentId);
  const ignored = settings.workIgnoredItems ?? [];
  const highlights = settings.workDemoHighlights ?? [];
  const events = calendar.result?.connected ? calendar.result.events : [];
  const period =
    mode === "weekly"
      ? now.getDay() === 1
        ? "since last Monday"
        : "this week"
      : today - lastWorkday <= 86_400_000 * 1.5
        ? "yesterday"
        : `since ${new Date(lastWorkday).toLocaleDateString([], { weekday: "long" })}`;
  const meetings =
    mode === "daily"
      ? events.slice(0, 30).map((event) => `${eventTime(event)} ${event.title}`.slice(0, 200))
      : [];

  // The daily standup ends at midnight; the weekly demo includes today. Both windows only move
  // at midnight, so an open dialog does not ask the server again every minute.
  const recap = useWorkRecap(
    environmentId,
    {
      mode,
      since: mode === "daily" ? lastWorkday : week,
      until: mode === "daily" ? today : tomorrow,
      period,
      date,
      dayStart: new Date(today).toISOString(),
      dayEnd: new Date(tomorrow).toISOString(),
      ...(meetings.length > 0 ? { meetings } : {}),
    },
    // Meetings are part of the standup; wait for the calendar so it is written once.
    mode === "weekly" || !calendar.loading,
  );
  const view = recap.view;
  const items = view?.items ?? [];
  const itemsByKey = new Map(items.map((item) => [item.keys[0]!, item]));
  const clusters: RecapClusterView[] = [
    ...(view?.features ?? []).map((feature) => ({
      title: feature.title,
      description: feature.description || null,
      items: feature.items.flatMap((key) => itemsByKey.get(key) ?? []),
      area: feature.area || null,
      minor: feature.minor,
    })),
    ...(view && view.unassigned.length > 0
      ? [
          {
            title: recap.writing ? "Grouping new work…" : "Not grouped yet",
            description: null,
            items: view.unassigned.flatMap((key) => itemsByKey.get(key) ?? []),
            area: "Other",
            minor: false,
          },
        ]
      : []),
  ];
  const minorClusters = bySize(clusters.filter((cluster) => cluster.minor));

  // Features under the areas the model named (Support, Mobile, …), biggest first by size: lines
  // changed and Slack messages, with diminishing returns. An area of one item gets no heading of
  // its own; those gather under "Other", which stays last.
  const byArea = new Map<string, RecapClusterView[]>();
  for (const cluster of clusters) {
    if (cluster.minor) continue;
    const area = cluster.area ?? "";
    byArea.set(area, [...(byArea.get(area) ?? []), cluster]);
  }
  const other: RecapClusterView[] = [];
  const areaSections = [...byArea]
    .flatMap(([area, list]) => {
      const count = list.reduce((total, cluster) => total + cluster.items.length, 0);
      if (area === "Other" || !area || (count === 1 && byArea.size > 1)) {
        other.push(...list);
        return [];
      }
      return [
        {
          area,
          clusters: bySize(list),
          count,
          size: workRecapFeatureSize(list.flatMap((cluster) => cluster.items)),
        },
      ];
    })
    .toSorted((a, b) => b.size - a.size)
    .concat(
      other.length > 0
        ? [
            {
              area: "Other",
              clusters: bySize(other),
              count: other.reduce((total, cluster) => total + cluster.items.length, 0),
              size: 0,
            },
          ]
        : [],
    );
  const smallerThings: RecapClusterView | null =
    minorClusters.length > 0
      ? {
          title: "Smaller things",
          description: minorClusters.map((cluster) => cluster.title).join(" · "),
          items: minorClusters.flatMap((cluster) => cluster.items),
          area: null,
          minor: true,
        }
      : null;

  const planned = buildWorkPlan(
    settings.workDayPlan?.date === date ? settings.workDayPlan.items : [],
    groups,
    ignored,
  );
  const plannedGroups = planned.map((item) => ({
    item,
    group: groups.find((candidate) => workMatchesMarks(workItemKeys(candidate), [item])),
  }));
  const waiting = mode === "daily" ? recapWaitingGroups(groups, ignored, now.getTime()) : [];
  const waitingTitles = new Map(
    (view?.waitingTitles ?? []).map((entry) => [entry.groupId, entry.title]),
  );

  async function copy() {
    const lines = [
      mode === "daily" ? `Standup · ${period}` : `Weekly demo · ${period}`,
      ...(view?.summary ? ["", view.summary.text] : []),
      "",
      ...[
        ...areaSections,
        ...(smallerThings ? [{ area: null, clusters: [smallerThings] }] : []),
      ].flatMap((section) => [
        ...(section.area ? [section.area.toUpperCase()] : []),
        ...section.clusters.flatMap(({ title, description, items: clusterItems }) => [
          description ? `${title} — ${description}` : title,
          ...clusterItems.map(
            (item) =>
              `  ${workMatchesMarks(item.keys, highlights) && mode === "weekly" ? "★" : "•"} ${item.title}${item.url ? ` ${item.url}` : ""}`,
          ),
          "",
        ]),
      ]),
      ...(mode === "daily" && planned.length > 0
        ? ["TODAY", ...planned.map((item) => `• ${item.title}`), ""]
        : []),
    ];
    await navigator.clipboard.writeText(lines.join("\n").trim()).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const renderRow = (item: WorkRecapItem, compact: boolean) => (
    <AccomplishmentRow
      key={item.keys.join("|")}
      item={item}
      compact={compact}
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
  );

  const shippedCount = items.length;
  const mergedCount = items.filter((item) => item.pullRequest?.state === "merged").length;

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

      <RecapSummaryCard environmentId={environmentId} recap={recap} />

      <div className="-mx-3 space-y-4">
        <div className="space-y-1">
          <WorkGroupHeader
            label={`Done ${period}`}
            count={shippedCount}
            action={
              <span className="shrink-0">
                {recap.writing && (view?.unassigned.length ?? 0) > 0
                  ? "Grouping new work…"
                  : mergedCount > 0
                    ? `${mergedCount} merged ${mergedCount === 1 ? "PR" : "PRs"}`
                    : null}
              </span>
            }
          />
          {view && shippedCount === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              Nothing finished {period}. Work counts once a thread changes files, a PR merges, or
              you mark your own conversation done.
            </p>
          ) : null}
        </div>
        {shippedCount > 0 ? (
          <div className="space-y-5 px-3">
            {areaSections.map((section) => (
              <section key={section.area ?? ""} className="space-y-2">
                {section.area ? (
                  <div className="flex items-baseline gap-2">
                    <h4 className="text-sm font-semibold">{section.area}</h4>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {section.count} {section.count === 1 ? "item" : "items"}
                    </span>
                  </div>
                ) : null}
                {section.clusters.map((cluster) => (
                  <RecapCluster
                    key={`${cluster.title}:${cluster.items[0]?.keys[0] ?? ""}`}
                    cluster={cluster}
                    highlights={mode === "weekly" ? highlights : null}
                    renderRow={renderRow}
                  />
                ))}
              </section>
            ))}
            {smallerThings ? (
              <RecapCluster
                cluster={smallerThings}
                highlights={mode === "weekly" ? highlights : null}
                renderRow={renderRow}
              />
            ) : null}
          </div>
        ) : null}

        {mode === "daily" ? (
          <>
            {plannedGroups.length > 0 ? (
              <div className="space-y-0.5">
                <WorkGroupHeader label="Planned today" count={planned.length} />
                {plannedGroups.map(({ item, group }, index) => (
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
                ))}
              </div>
            ) : null}

            {events.length > 0 || calendar.error ? (
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
            ) : null}

            {plannedGroups.length === 0 &&
            events.length === 0 &&
            !calendar.error &&
            !calendar.loading ? (
              <p className="px-3 text-xs text-muted-foreground">
                No plan or meetings for today. Choose “Plan for today” on a work item
                {calendar.result?.connected
                  ? ""
                  : ", or connect Google Calendar in Settings → Work"}
                .
              </p>
            ) : null}

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
                    title={waitingTitles.get(group.id) ?? workGroupTitle(group)}
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
            Star what you want to show; stars carry into the copied text.
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
