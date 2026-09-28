import type { EnvironmentId, SlackMessage, SlackReaction, SlackThread } from "@t3tools/contracts";
import { SmilePlusIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { slackEnvironment } from "~/state/slack";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import ChatMarkdown, { ChatMarkdownAssetImage } from "../ChatMarkdown";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { Button } from "../ui/button";
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

export function SlackMessageBody({
  environmentId,
  message,
  onToggleReaction,
}: {
  readonly environmentId: EnvironmentId;
  readonly message: SlackMessage;
  readonly onToggleReaction: (name: string, reacted: boolean) => void;
}) {
  const remainingFiles = Math.max(0, message.fileCount - (message.images?.length ?? 0));
  const [preview, setPreview] = useState<ExpandedImagePreview | null>(null);
  return (
    <div className="flex min-w-0 gap-3" data-image-gallery>
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
        {message.images?.map((image) => (
          <ChatMarkdownAssetImage
            key={image.id}
            environmentId={environmentId}
            resource={{ _tag: "slack-image", url: image.url }}
            alt={image.name}
            maxHeightRem={20}
            imageProps={{ loading: "lazy" }}
            onImageExpand={setPreview}
          />
        ))}
        {remainingFiles > 0 ? (
          <p className="text-xs text-muted-foreground">
            {remainingFiles === 1 ? "1 file" : `${remainingFiles} files`}, open in Slack to view
          </p>
        ) : null}
        <SlackReactionBar reactions={message.reactions} onToggle={onToggleReaction} />
        {preview ? (
          <ExpandedImageDialog preview={preview} onClose={() => setPreview(null)} />
        ) : null}
      </div>
    </div>
  );
}

type RepliesState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly messages: ReadonlyArray<SlackMessage> }
  | { readonly status: "error" };

/**
 * A Slack conversation read in full: the root message and its replies, which reload whenever
 * the feed reports a newer reply. Reactions can be toggled on any message.
 */
export function SlackConversationView({
  environmentId,
  thread,
}: {
  readonly environmentId: EnvironmentId;
  readonly thread: SlackThread;
}) {
  const setReaction = useAtomCommand(slackEnvironment.setReaction, { reportFailure: false });
  const getReplies = useAtomCommand(slackEnvironment.getReplies, { reportFailure: false });
  const [replies, setReplies] = useState<RepliesState>({ status: "loading" });
  const [reloads, setReloads] = useState(0);
  const hasReplies = thread.replyCount > 0;
  // A new request whenever the feed reports a newer reply or a reply's reactions change, so
  // the open conversation follows along.
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
    if (!hasReplies) return;
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
  }, [environmentId, getReplies, hasReplies, repliesRequest]);

  const toggleReaction = useCallback(
    async (ts: string, name: string, reacted: boolean) => {
      const result = await setReaction({
        environmentId,
        input: { channelId: thread.channelId, ts, name, reacted },
      });
      if (result._tag === "Failure") {
        toastManager.add({ type: "error", title: "The reaction could not be saved" });
        return;
      }
      if (ts !== thread.ts) setReloads((count) => count + 1);
    },
    [environmentId, setReaction, thread.channelId, thread.ts],
  );

  return (
    <div className="flex flex-col gap-4">
      <SlackMessageBody
        environmentId={environmentId}
        message={thread}
        onToggleReaction={(name, reacted) => void toggleReaction(thread.ts, name, reacted)}
      />
      {hasReplies ? (
        <div className="flex flex-col gap-4 border-l border-border/70 ps-4">
          {replies.status === "loading" ? (
            <Spinner className="size-4" />
          ) : replies.status === "error" ? (
            <p className="text-xs text-destructive">Replies could not be loaded.</p>
          ) : (
            replies.messages.map((reply) => (
              <SlackMessageBody
                environmentId={environmentId}
                key={reply.ts}
                message={reply}
                onToggleReaction={(name, reacted) => void toggleReaction(reply.ts, name, reacted)}
              />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
