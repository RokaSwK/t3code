import type { DevinSessionState, SlackChannelKind } from "@t3tools/contracts";
import { BotIcon, HashIcon, LockIcon, MessageCircleIcon, UsersIcon } from "lucide-react";
import { memo, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { T3Wordmark } from "../T3Wordmark";
import { Separator } from "../ui/separator";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { WorkStatus } from "./workGroups";

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
  className,
}: {
  readonly status: WorkStatus | "new";
  readonly reason?: string;
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

/** One line of plain text from a Slack message, for a row title. */
export function slackMessageSummary(markdown: string): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    // Devin ends its messages with icon links to the session and its settings.
    .replace(/\[\[[^\]]*\]\]\([^)]*\)/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    // Devin's automations post for you as "@you: request".
    .replace(/^\s*\*{0,2}@[^:*\n]{1,40}\*{0,2}:\s*/, "")
    // A bare link says little in a title; the words around it say more.
    .replace(/<?https?:\/\/\S+>?/g, " ")
    // Slack shows some links by their address without the scheme.
    .replace(/(?:^|\s)(?:www\.)?[\w-]+(?:\.[\w-]+)+\/\S*/g, " ")
    .replace(/[*_~`>#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text || "Shared a link";
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

/**
 * A work row: a status column, then two lines. The title with the signals of what is working
 * on it; where it came from and why it has this status, with the time on the right.
 */
export const WorkRow = memo(function WorkRow({
  id,
  selected,
  glyph,
  title,
  signals,
  meta,
  updatedAt,
  onSelect,
}: {
  readonly id: string;
  readonly selected: boolean;
  readonly glyph: ReactNode;
  readonly title: string;
  readonly signals?: ReactNode;
  readonly meta: ReactNode;
  readonly updatedAt: string;
  readonly onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect(id)}
      className={cn(
        "flex w-full cursor-pointer items-start gap-2 rounded-md px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        // Offscreen rows skip style and layout; a long Done list costs what is on screen.
        "[content-visibility:auto] [contain-intrinsic-block-size:36px]",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <span className="mt-0.5 flex">{glyph}</span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
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
