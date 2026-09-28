import { type ComponentProps, useMemo, useState } from "react";
import type { EnvironmentId, SlackState } from "@t3tools/contracts";
import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useProjects, useServerConfigs, useThreadShells } from "~/state/entities";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "../ui/dialog";
import {
  buildWorkAccomplishments,
  buildWorkPlan,
  localWorkDate,
  workRecapWindows,
} from "./workRecap";
import {
  includedWorkProjects,
  workMatchesMarks,
  workItemKeys,
  workItemTitle,
  type WorkGroup,
} from "./workGroups";
import { useWorkCalendar } from "./WorkCalendar";

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
  const [mode, setMode] = useState<"daily" | "weekly">("daily");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const calendar = useWorkCalendar(environmentId);
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
  // Grouped by project so a standup reads as areas of work, not a log of threads.
  const sections = new Map<string, Array<(typeof completed)[number]>>();
  for (const item of completed) {
    const title =
      (item.project &&
        projects.find(
          (project) =>
            project.environmentId === item.project!.environmentId &&
            project.id === item.project!.projectId,
        )?.title) ||
      "Other";
    sections.set(title, [...(sections.get(title) ?? []), item]);
  }
  const sectionEntries = [...sections].toSorted(
    ([a, aItems], [b, bItems]) =>
      Number(a === "Other") - Number(b === "Other") || bItems.length - aItems.length,
  );
  const sectionLines = (line: (item: (typeof completed)[number]) => string) =>
    sectionEntries.flatMap(([title, items]) => [
      ...(sectionEntries.length > 1 ? [title] : []),
      ...items.map(line),
    ]);
  const planned = buildWorkPlan(
    settings.workDayPlan?.date === date ? settings.workDayPlan.items : [],
    groups,
    settings.workIgnoredItems ?? [],
  );
  const waiting = groups.filter(
    (group) =>
      group.status === "waiting" &&
      group.owner === null &&
      !workMatchesMarks(workItemKeys(group), settings.workIgnoredItems ?? []),
  );
  const highlights = settings.workDemoHighlights ?? [];
  const eventLine = (event: NonNullable<typeof calendar.result>["events"][number]) =>
    `${event.allDay ? "All day" : new Date(event.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} — ${event.title}${event.location ? ` (${event.location})` : ""}`;
  async function copy() {
    const lines =
      mode === "daily"
        ? [
            "Daily standup",
            "",
            `Done ${period}`,
            ...sectionLines((item) => `- ${item.title}`),
            "",
            "Planned today",
            ...planned.map((item) => `- ${item.title}`),
            ...(calendar.error
              ? ["- Calendar unavailable"]
              : (calendar.result?.events ?? []).map((event) => `- ${eventLine(event)}`)),
            "",
            "Waiting on",
            ...waiting.map(
              (group) => `- ${workItemTitle(group)}${group.reason ? ` — ${group.reason}` : ""}`,
            ),
          ]
        : [
            `Weekly demo · ${period}`,
            "",
            ...sectionLines(
              (item) =>
                `${workMatchesMarks(item.keys, highlights) ? "★" : "-"} ${item.title}${item.url ? ` (${item.url})` : ""}`,
            ),
          ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  }
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={mode === "daily" ? "default" : "outline"}
          onClick={() => {
            setMode("daily");
            setCopied(false);
          }}
        >
          Daily standup
        </Button>
        <Button
          size="sm"
          variant={mode === "weekly" ? "default" : "outline"}
          onClick={() => {
            setMode("weekly");
            setCopied(false);
          }}
        >
          Weekly demo
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={mode === "daily" && calendar.loading}
          onClick={() => void copy()}
        >
          {copied ? "Copied" : "Copy summary"}
        </Button>
      </div>
      {copyError ? (
        <p role="alert" className="text-sm text-destructive">
          Clipboard unavailable. You can select and copy the text below.
        </p>
      ) : null}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Completed {period}</h3>
        {completed.length === 0 ? (
          <p className="text-sm text-muted-foreground">No recorded completions in this period.</p>
        ) : (
          sectionEntries.map(([title, items]) => (
            <div key={title} className="space-y-2">
              {sectionEntries.length > 1 ? (
                <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
              ) : null}
              <ul className="space-y-3">
                {items.map((item) => (
                  <li key={item.keys.join("|")} className="flex items-start gap-2">
                    <div className="min-w-0 flex-1 text-sm">
                      {item.url ? (
                        <a
                          className="underline underline-offset-2"
                          href={item.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {item.title}
                        </a>
                      ) : item.groupId ? (
                        <button
                          type="button"
                          className="text-left underline underline-offset-2"
                          onClick={() => onSelect(item.groupId!)}
                        >
                          {item.title}
                        </button>
                      ) : (
                        item.title
                      )}
                      <p className="text-xs text-muted-foreground">
                        {item.evidence} · {new Date(item.at).toLocaleDateString()}
                      </p>
                    </div>
                    {mode === "weekly" ? (
                      <Button
                        size="xs"
                        variant={workMatchesMarks(item.keys, highlights) ? "secondary" : "ghost"}
                        onClick={() =>
                          update({
                            workDemoHighlights: workMatchesMarks(item.keys, highlights)
                              ? highlights.filter((mark) => !workMatchesMarks(item.keys, [mark]))
                              : [
                                  ...highlights,
                                  { keys: item.keys, title: item.title, at: item.at },
                                ],
                          })
                        }
                      >
                        {workMatchesMarks(item.keys, highlights) ? "★ Highlighted" : "Highlight"}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </section>
      {mode === "daily" ? (
        <>
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Planned today</h3>
            {planned.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Open any work item and choose “Plan for today”.
              </p>
            ) : (
              <ul className="space-y-2">
                {planned.map((item, index) => {
                  const group = groups.find((candidate) =>
                    workMatchesMarks(workItemKeys(candidate), [item]),
                  );
                  return (
                    <li key={item.keys.join("|")} className="flex items-center gap-2">
                      <div className="min-w-0 flex-1 text-sm">
                        {group ? (
                          <button
                            className="text-left underline underline-offset-2"
                            onClick={() => onSelect(group.id)}
                          >
                            {item.title}
                          </button>
                        ) : (
                          item.title
                        )}
                      </div>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() =>
                          update({
                            workDayPlan: { date, items: planned.filter((_, i) => i !== index) },
                          })
                        }
                      >
                        Remove
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Today's calendar</h3>
              <Button
                size="xs"
                variant="ghost"
                disabled={calendar.loading}
                onClick={() => void calendar.refresh()}
              >
                {calendar.loading ? "Loading…" : "Refresh"}
              </Button>
            </div>
            {calendar.error ? (
              <p role="alert" className="text-sm text-destructive">
                {calendar.error}
              </p>
            ) : calendar.result?.connected ? (
              calendar.result.events.length ? (
                <ul className="space-y-2 text-sm">
                  {calendar.result.events.map((event) => (
                    <li key={event.id}>{eventLine(event)}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No events today.</p>
              )
            ) : !calendar.loading ? (
              <p className="text-sm text-muted-foreground">
                Connect Google Calendar in Settings → Work.
              </p>
            ) : null}
          </section>
          {waiting.length ? (
            <section className="space-y-3">
              <h3 className="text-sm font-semibold">Waiting on</h3>
              <ul className="space-y-2 text-sm">
                {waiting.map((group) => (
                  <li key={group.id}>
                    <button
                      className="text-left underline underline-offset-2"
                      onClick={() => onSelect(group.id)}
                    >
                      {workItemTitle(group)}
                    </button>
                    <p className="text-xs text-muted-foreground">{group.reason}</p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Highlight the accomplishments you want to show in your weekly demo. Stars are included
          when you copy the summary.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Based on marked-done work, merged PRs, and settled threads that changed files. Dates use
        your local timezone.
      </p>
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
          <DialogTitle>Your work recap</DialogTitle>
          <DialogDescription>Prepare your daily standup and weekly demo.</DialogDescription>
        </DialogHeader>
        <DialogPanel>{open ? <WorkRecapPanel {...props} /> : null}</DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
