import type { DevinSessionState, SlackChannelKind } from "@t3tools/contracts";
import {
  AlarmClockIcon,
  BotIcon,
  CheckIcon,
  HashIcon,
  LockIcon,
  MessageCircleIcon,
  PinIcon,
  SlackIcon,
  UsersIcon,
} from "lucide-react";
import { memo, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { T3Wordmark } from "../T3Wordmark";
import { GitHubIcon } from "../Icons";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { WorkStatus } from "./workGroups";
import { WorkSnoozeMenu } from "./workTriage";

export { slackMessageSummary } from "@t3tools/shared/work";

/** The sidebar's thread status colors, so a status reads the same on every surface. */
export const WORK_STATUS_PRESENTATION: Record<
  WorkStatus,
  { readonly label: string; readonly dotClass: string; readonly textClass: string }
> = {
  needs: {
    label: "Needs me",
    dotClass: "bg-amber-500 dark:bg-amber-300/90",
    textClass: "text-amber-600 dark:text-amber-300/90",
  },
  working: {
    label: "In progress",
    dotClass: "bg-sky-500 dark:bg-sky-300/80",
    textClass: "text-sky-600 dark:text-sky-300/80",
  },
  waiting: {
    label: "Waiting",
    dotClass: "border border-muted-foreground/60 bg-transparent",
    textClass: "text-muted-foreground",
  },
  done: {
    label: "Done",
    dotClass: "bg-emerald-500/70 dark:bg-emerald-300/60",
    textClass: "text-emerald-600 dark:text-emerald-300/80",
  },
};

export const DEVIN_STATE_PRESENTATION: Record<
  DevinSessionState,
  { readonly label: string; readonly className: string }
> = {
  working: { label: "working", className: "text-sky-600 dark:text-sky-300/80" },
  waiting: { label: "waiting for you", className: "text-amber-600 dark:text-amber-300/90" },
  finished: { label: "finished", className: "text-muted-foreground" },
  suspended: { label: "asleep", className: "text-muted-foreground" },
  error: { label: "stopped", className: "text-destructive" },
};

export function WorkStatusDot({
  status,
  reason,
  hint,
  className,
}: {
  readonly status: WorkStatus | "new";
  readonly reason?: string;
  /** A second tooltip line, such as what modifier clicks do. */
  readonly hint?: string;
  readonly className?: string;
}) {
  const presentation = status === "new" ? null : WORK_STATUS_PRESENTATION[status];
  return (
    <Tooltip>
      {/* Rows are buttons, so the trigger stays a span and does not steal the row's click. */}
      <TooltipTrigger render={<span className={cn("inline-flex size-4 shrink-0", className)} />}>
        <span
          role="img"
          aria-label={presentation ? `${presentation.label}: ${reason}` : "New"}
          className={cn(
            "m-auto size-2 rounded-full",
            presentation?.dotClass ?? "border border-primary/70 bg-primary/20",
          )}
        />
      </TooltipTrigger>
      <TooltipPopup side="top">
        {presentation ? `${presentation.label} · ${reason}` : "New thread"}
        {hint ? <span className="block text-muted-foreground">{hint}</span> : null}
      </TooltipPopup>
    </Tooltip>
  );
}

export function SlackChannelGlyph({
  kind,
  className,
}: {
  readonly kind: SlackChannelKind;
  readonly className?: string;
}) {
  const Icon =
    kind === "private"
      ? LockIcon
      : kind === "group"
        ? UsersIcon
        : kind === "dm"
          ? MessageCircleIcon
          : HashIcon;
  return <Icon aria-hidden className={cn("size-3 shrink-0", className)} />;
}

/** Devin's own logo, from its Slack profile; a robot until Slack has named it. */
export function DevinLogo({
  url,
  label = "Devin",
  className,
}: {
  readonly url: string | undefined;
  readonly label?: string;
  readonly className?: string;
}) {
  if (!url) return <BotIcon aria-label={label} className={cn("size-3.5 shrink-0", className)} />;
  return (
    <img
      alt={label}
      src={url}
      loading="lazy"
      // Devin's avatar is a dark mark on white; inverted it sits like an icon on dark themes.
      className={cn("size-3.5 shrink-0 rounded-xs dark:invert", className)}
    />
  );
}

/** The T3 mark, for T3 threads working on a conversation. */
export function T3Logo({ className }: { readonly className?: string }) {
  return (
    <span
      role="img"
      aria-label="T3 thread"
      className={cn("inline-flex size-3.5 shrink-0 items-center justify-center", className)}
    >
      <T3Wordmark aria-hidden className="h-2 w-auto" />
    </span>
  );
}

/** Section heading in the list, the pull request list's shape. */
export function WorkGroupHeader({
  label,
  count,
  action,
}: {
  readonly label: string;
  readonly count: number;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-3 pb-1 text-xs font-medium text-muted-foreground/70">
      <h2 className="shrink-0">{label}</h2>
      <span className="shrink-0 tabular-nums text-muted-foreground/50">{count}</span>
      <Separator className="min-w-2 flex-1" />
      {action}
    </div>
  );
}

export type WorkRowAction =
  | { readonly kind: "done" }
  | { readonly kind: "ignore" }
  | { readonly kind: "snooze"; readonly until: number };

/** Done and snooze on a row, shown on hover or focus over the row's end, so nothing shifts. */
function WorkRowActions({
  id,
  canDone,
  onAction,
}: {
  readonly id: string;
  readonly canDone: boolean;
  readonly onAction: (id: string, action: WorkRowAction) => void;
}) {
  return (
    <div className="pointer-events-none absolute top-1.5 right-2 flex items-center gap-0.5 rounded-md bg-accent opacity-0 group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100 has-[[data-popup-open]]:pointer-events-auto has-[[data-popup-open]]:opacity-100">
      {canDone ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Done"
                onClick={() => onAction(id, { kind: "done" })}
              />
            }
          >
            <CheckIcon />
          </TooltipTrigger>
          <TooltipPopup side="top">Done (E)</TooltipPopup>
        </Tooltip>
      ) : null}
      <WorkSnoozeMenu
        menuId={id}
        trigger={<Button size="icon-xs" variant="ghost" aria-label="Snooze" />}
        onSnooze={(until) => onAction(id, { kind: "snooze", until })}
      >
        <AlarmClockIcon />
      </WorkSnoozeMenu>
    </div>
  );
}

/**
 * A work row: a status column, then two lines. The title with the signals of what is working
 * on it; where it came from and why it has this status, with the time on the right. With
 * `onAction`, the status dot takes Cmd/Ctrl-click for done and Shift-click for ignore.
 */
export const WorkRow = memo(function WorkRow({
  id,
  selected,
  glyph,
  source,
  title,
  signals,
  meta,
  updatedAt,
  pinned = false,
  canDone = false,
  onSelect,
  onAction,
}: {
  readonly id: string;
  readonly selected: boolean;
  readonly glyph: ReactNode;
  readonly source: "slack" | "github" | "t3";
  readonly title: string;
  readonly signals?: ReactNode;
  readonly meta: ReactNode;
  readonly updatedAt: string;
  readonly pinned?: boolean;
  /** Whether marking it done is up to the user; pull requests leave when they close. */
  readonly canDone?: boolean;
  readonly onSelect: (id: string) => void;
  readonly onAction?: (id: string, action: WorkRowAction) => void;
}) {
  return (
    <div data-work-row={id} className="group/row relative">
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={(event) => {
          const onDot =
            event.target instanceof Element && event.target.closest("[data-work-dot]") !== null;
          if (onAction && onDot && (event.metaKey || event.ctrlKey)) {
            if (canDone) onAction(id, { kind: "done" });
            return;
          }
          if (onAction && onDot && event.shiftKey) {
            onAction(id, { kind: "ignore" });
            return;
          }
          onSelect(id);
        }}
        className={cn(
          "flex w-full cursor-pointer items-start gap-2 rounded-md px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          // Offscreen rows skip style and layout; a long Done list costs what is on screen.
          "[content-visibility:auto] [contain-intrinsic-block-size:36px]",
          selected ? "bg-accent" : "hover:bg-accent/60",
        )}
      >
        <span className="mt-0.5 flex shrink-0 items-center gap-1 text-muted-foreground">
          <span
            data-work-dot
            className="inline-flex"
            // A modifier click acts on the item; it should not select text.
            onMouseDown={(event) => {
              if (event.shiftKey || event.metaKey || event.ctrlKey) event.preventDefault();
            }}
          >
            {glyph}
          </span>
          {source === "slack" ? (
            <SlackIcon role="img" aria-label="From Slack" className="size-3.5" />
          ) : source === "github" ? (
            <GitHubIcon role="img" aria-label="From GitHub" className="size-3.5" />
          ) : (
            <T3Logo />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            {pinned ? (
              <PinIcon aria-label="Pinned" className="size-3 shrink-0 text-muted-foreground" />
            ) : null}
            <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
            {signals ? (
              // Pinned to the row's end, over the time, however short the title is.
              <span className="flex shrink-0 items-center gap-1.5 text-2xs text-muted-foreground">
                {signals}
              </span>
            ) : null}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 overflow-hidden text-2xs text-muted-foreground">
            {meta}
            <span className="ml-auto shrink-0 whitespace-nowrap tabular-nums">
              {formatRelativeTimeLabel(updatedAt)}
            </span>
          </span>
        </span>
      </button>
      {onAction ? <WorkRowActions id={id} canDone={canDone} onAction={onAction} /> : null}
    </div>
  );
});

/** Author avatar and name at the meta line's size. */
export function WorkRowAuthor({
  name,
  avatarUrl,
}: {
  readonly name: string;
  readonly avatarUrl?: string | undefined;
}) {
  return (
    <span className="inline-flex min-w-0 max-w-40 shrink items-center gap-1">
      {avatarUrl ? (
        <img alt="" loading="lazy" className="size-3.5 shrink-0 rounded-sm" src={avatarUrl} />
      ) : null}
      <span className="truncate">{name}</span>
    </span>
  );
}

export const WORK_META_SEPARATOR = <span className="shrink-0 text-muted-foreground/40">·</span>;
