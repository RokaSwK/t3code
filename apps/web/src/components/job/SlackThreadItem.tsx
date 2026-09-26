import type { EnvironmentId, SlackMessage, SlackReaction, SlackThread } from "@t3tools/contracts";
import { ExternalLinkIcon, HashIcon, LockIcon, SmilePlusIcon, UsersIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { slackEnvironment } from "~/state/slack";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import ChatMarkdown from "../ChatMarkdown";
import { Button, InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const PILL_CLASS =
  "inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring";

/** One tap reactions; anything else can be added from Slack. */
const QUICK_REACTIONS: ReadonlyArray<readonly [name: string, emoji: string]> = [
  ["+1", "👍"],
  ["heart", "❤️"],
  ["joy", "😂"],
  ["tada", "🎉"],
  ["eyes", "👀"],
  ["white_check_mark", "✅"],
  ["pray", "🙏"],
  ["fire", "🔥"],
];

function slackTsIso(ts: string): string {
  return new Date(Number.parseFloat(ts) * 1000).toISOString();
}

function openExternal(url: string) {
  void readLocalApi()?.shell.openExternal(url);
}

function ReactionGlyph({ reaction }: { readonly reaction: SlackReaction }) {
  if (reaction.unicode) return <span aria-hidden>{reaction.unicode}</span>;
  if (reaction.imageUrl) {
    return <img alt="" className="size-4 object-contain" src={reaction.imageUrl} />;
  }
  return <span aria-hidden>:{reaction.name}:</span>;
}

function SlackReactionBar({
  reactions,
  onToggle,
}: {
  readonly reactions: ReadonlyArray<SlackReaction>;
  readonly onToggle: (name: string, reacted: boolean) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {reactions.map((reaction) => (
        <Tooltip key={reaction.name}>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-pressed={reaction.reacted}
                aria-label={`${reaction.name}, ${reaction.count}`}
                className={cn(
                  PILL_CLASS,
                  reaction.reacted
                    ? "border-primary/60 bg-primary/10 text-foreground"
                    : "border-border/70 bg-muted/40 text-muted-foreground hover:border-primary/60",
                )}
                onClick={() => onToggle(reaction.name, !reaction.reacted)}
              />
            }
          >
            <ReactionGlyph reaction={reaction} />
            <span className="tabular-nums">{reaction.count}</span>
          </TooltipTrigger>
          <TooltipPopup side="top">:{reaction.name}:</TooltipPopup>
        </Tooltip>
      ))}
      <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label="Add reaction"
              className={cn(
                PILL_CLASS,
                "border-border/70 text-muted-foreground hover:border-primary/60 hover:text-foreground",
              )}
            />
          }
        >
          <SmilePlusIcon className="size-3.5" />
        </PopoverTrigger>
        <PopoverPopup side="top" align="start" className="w-auto">
          <div className="flex gap-1">
            {QUICK_REACTIONS.map(([name, emoji]) => (
              <Button
                key={name}
                size="icon-sm"
                variant="ghost"
                aria-label={name}
                onClick={() => {
                  setPickerOpen(false);
                  const existing = reactions.find((reaction) => reaction.name === name);
                  if (!existing?.reacted) onToggle(name, true);
                }}
              >
                {emoji}
              </Button>
            ))}
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
}

function SlackMessageBody({
  message,
  onToggleReaction,
}: {
  readonly message: SlackMessage;
  readonly onToggleReaction: (name: string, reacted: boolean) => void;
}) {
  return (
    <div className="flex min-w-0 gap-3">
      {message.authorAvatarUrl ? (
        <img
          alt=""
          className="size-8 shrink-0 rounded-md bg-muted"
          loading="lazy"
          src={message.authorAvatarUrl}
        />
      ) : (
        <div className="size-8 shrink-0 rounded-md bg-muted" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-semibold">{message.authorName}</span>
          <time
            className="shrink-0 text-xs text-muted-foreground"
            dateTime={slackTsIso(message.ts)}
          >
            {formatRelativeTimeLabel(slackTsIso(message.ts))}
            {message.edited ? " (edited)" : ""}
          </time>
        </div>
        {message.markdown.trim() ? (
          <ChatMarkdown
            text={message.markdown}
            cwd={undefined}
            lineBreaks
            parseRawHtml={false}
            className="text-sm"
          />
        ) : null}
        {message.fileCount > 0 ? (
          <p className="text-xs text-muted-foreground">
            {message.fileCount === 1 ? "1 file" : `${message.fileCount} files`}, open in Slack to
            view
          </p>
        ) : null}
        <SlackReactionBar reactions={message.reactions} onToggle={onToggleReaction} />
      </div>
    </div>
  );
}

type RepliesState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly messages: ReadonlyArray<SlackMessage> }
  | { readonly status: "error" };

function ChannelGlyph({ kind }: { readonly kind: SlackThread["channelKind"] }) {
  const Icon = kind === "private" ? LockIcon : kind === "group" ? UsersIcon : HashIcon;
  return <Icon aria-hidden className="size-3" />;
}

/** A Slack thread in the feed, with its replies loaded on demand. */
export const SlackThreadItem = memo(function SlackThreadItem({
  environmentId,
  thread,
}: {
  readonly environmentId: EnvironmentId;
  readonly thread: SlackThread;
}) {
  const setReaction = useAtomCommand(slackEnvironment.setReaction, { reportFailure: false });
  const getReplies = useAtomCommand(slackEnvironment.getReplies, { reportFailure: false });
  const [repliesOpen, setRepliesOpen] = useState(false);
  const [replies, setReplies] = useState<RepliesState>({ status: "loading" });

  const [reloads, setReloads] = useState(0);
  // A new request whenever the feed reports a newer reply or a reply's reactions change, so an
  // open thread follows along.
  const repliesRequest = useMemo(
    () => ({
      channelId: thread.channelId,
      ts: thread.ts,
      latestReplyTs: thread.latestReplyTs,
      reloads,
    }),
    [thread.channelId, thread.ts, thread.latestReplyTs, reloads],
  );
  useEffect(() => {
    if (!repliesOpen) return;
    let cancelled = false;
    void getReplies({
      environmentId,
      input: { channelId: repliesRequest.channelId, ts: repliesRequest.ts },
    }).then((result) => {
      if (cancelled) return;
      setReplies(
        result._tag === "Success"
          ? { status: "ready", messages: result.value }
          : { status: "error" },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, getReplies, repliesOpen, repliesRequest]);

  const toggleReaction = useCallback(
    async (ts: string, name: string, reacted: boolean, isReply: boolean) => {
      const result = await setReaction({
        environmentId,
        input: { channelId: thread.channelId, ts, name, reacted },
      });
      if (result._tag === "Failure") {
        toastManager.add({ type: "error", title: "The reaction could not be saved" });
        return;
      }
      if (isReply) setReloads((count) => count + 1);
    },
    [environmentId, setReaction, thread.channelId],
  );

  return (
    <article className="flex flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground">
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <span className="inline-flex min-w-0 items-center gap-1">
          <ChannelGlyph kind={thread.channelKind} />
          <span className="truncate">{thread.channelName}</span>
        </span>
        <InlineButton
          tone="muted"
          className="ms-auto shrink-0"
          onClick={() => openExternal(thread.permalink)}
        >
          Open in Slack
          <ExternalLinkIcon />
        </InlineButton>
      </div>
      <SlackMessageBody
        message={thread}
        onToggleReaction={(name, reacted) => void toggleReaction(thread.ts, name, reacted, false)}
      />
      {thread.replyCount > 0 ? (
        <div className="flex flex-col gap-3 ps-11">
          <InlineButton
            tone="muted"
            className="self-start"
            onClick={() => {
              if (!repliesOpen) setReplies({ status: "loading" });
              setRepliesOpen(!repliesOpen);
            }}
          >
            {repliesOpen
              ? "Hide replies"
              : thread.replyCount === 1
                ? "1 reply"
                : `${thread.replyCount} replies`}
            {thread.latestReplyTs && !repliesOpen
              ? `, last ${formatRelativeTimeLabel(slackTsIso(thread.latestReplyTs))}`
              : ""}
          </InlineButton>
          {repliesOpen ? (
            replies.status === "loading" ? (
              <Spinner className="size-4" />
            ) : replies.status === "error" ? (
              <p className="text-xs text-destructive">Replies could not be loaded.</p>
            ) : (
              replies.messages.map((reply) => (
                <SlackMessageBody
                  key={reply.ts}
                  message={reply}
                  onToggleReaction={(name, reacted) =>
                    void toggleReaction(reply.ts, name, reacted, true)
                  }
                />
              ))
            )
          ) : null}
        </div>
      ) : null}
    </article>
  );
});
