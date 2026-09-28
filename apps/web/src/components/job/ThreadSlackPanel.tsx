import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  parseSlackThreadUrl,
  SLACK_FOLLOW_REACTION,
  type ScopedThreadRef,
  type SlackThreadDetail,
} from "@t3tools/contracts";
import { ExternalLinkIcon, RefreshCwIcon, SlackIcon, UnlinkIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { readLocalApi } from "~/localApi";
import { useThreadShell } from "~/state/entities";
import { useEnvironment } from "~/state/environments";
import { slackEnvironment } from "~/state/slack";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SlackMessageBody } from "./SlackConversationView";

function SlackConversation({ threadRef, url }: { threadRef: ScopedThreadRef; url: string }) {
  const connected = useEnvironment(threadRef.environmentId)?.connection.phase === "connected";
  const getThread = useAtomCommand(slackEnvironment.getThread, { reportFailure: false });
  const setReaction = useAtomCommand(slackEnvironment.setReaction, { reportFailure: false });
  const [detail, setDetail] = useState<SlackThreadDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    void getThread({ environmentId: threadRef.environmentId, input: { url } }).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (result._tag === "Success") {
        setDetail(result.value);
        setError(null);
      } else {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Could not load this Slack thread.");
      }
    });
    return () => {
      cancelled = true;
    };
    // Refresh explicitly reruns this request without polling the Slack API.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [getThread, threadRef.environmentId, url, revision, connected]);
  const refresh = () => {
    setLoading(true);
    setRevision((value) => value + 1);
  };
  return (
    <section className="flex min-w-0 flex-col gap-4 p-4" aria-label="Slack conversation">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {detail ? `#${detail.thread.channelName}` : "Slack thread"}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Refresh Slack thread"
          disabled={loading || !connected}
          onClick={refresh}
        >
          <RefreshCwIcon className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Open thread in Slack"
          onClick={() => void readLocalApi()?.shell.openExternal(url)}
        >
          <ExternalLinkIcon className="size-4" />
        </Button>
      </div>
      {!connected ? (
        <p role="status" className="text-sm text-muted-foreground">
          Waiting for the environment connection…
        </p>
      ) : null}
      {connected && loading && !detail ? (
        <p className="text-sm text-muted-foreground" role="status">
          Loading Slack thread…
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {detail
        ? [detail.thread, ...detail.replies].map((message) => (
            <SlackMessageBody
              key={message.ts}
              environmentId={threadRef.environmentId}
              message={message}
              onToggleReaction={(name, reacted) => {
                void setReaction({
                  environmentId: threadRef.environmentId,
                  input: { channelId: message.channelId, ts: message.ts, name, reacted },
                }).then((result) => {
                  if (result._tag === "Success") refresh();
                  else setError("The reaction could not be saved.");
                });
              }}
            />
          ))
        : null}
      {detail?.hasMore ? (
        <p className="text-xs text-muted-foreground">
          Showing the first 200 messages. Open in Slack to read the rest.
        </p>
      ) : null}
    </section>
  );
}

/** Durable links belong to the T3 thread; only the selected conversation is loaded. */
export function ThreadSlackPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const thread = useThreadShell(threadRef);
  const update = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  const follow = useAtomCommand(slackEnvironment.setReaction, { reportFailure: false });
  const links = thread?.linkedSlackThreads ?? [];
  const [input, setInput] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeUrl = selected && links.includes(selected) ? selected : links[0];
  const save = async (next: readonly string[]) => {
    setSaving(true);
    setError(null);
    const result = await update({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, linkedSlackThreads: next },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      setError("Could not save Slack links. Check the environment connection and try again.");
      return false;
    }
    return true;
  };
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="flex flex-col gap-3 border-b p-4">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <SlackIcon className="size-4" />
          Linked Slack threads
        </h2>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = parseSlackThreadUrl(input);
            if (!parsed) {
              setError("Paste a Slack message or thread link.");
              return;
            }
            if (links.includes(parsed.url)) {
              setSelected(parsed.url);
              setInput("");
              setError(null);
              return;
            }
            if (links.length >= 20) {
              setError("A T3 thread can link up to 20 Slack threads.");
              return;
            }
            void save([...links, parsed.url]).then((saved) => {
              if (saved) {
                setSelected(parsed.url);
                setInput("");
                // A linked conversation is one of yours on the Work page; 👀 is how that is kept.
                void follow({
                  environmentId: threadRef.environmentId,
                  input: {
                    channelId: parsed.channelId,
                    ts: parsed.ts,
                    name: SLACK_FOLLOW_REACTION,
                    reacted: true,
                  },
                });
              }
            });
          }}
        >
          <div className="min-w-0 flex-1">
            <Input
              aria-label="Slack thread URL"
              placeholder="Paste a Slack thread link"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              disabled={saving}
            />
          </div>
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={saving || !thread || !input.trim()}
          >
            Link
          </Button>
        </form>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        {!links.length ? (
          <p className="text-sm text-muted-foreground">
            Copy a message link from Slack and paste it here to open its conversation beside this
            thread.
          </p>
        ) : null}
        {links.map((url) => {
          const parsed = parseSlackThreadUrl(url);
          return (
            <div key={url} className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                aria-pressed={activeUrl === url}
                onClick={() => setSelected(url)}
                className="min-w-0 flex-1 truncate rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent aria-pressed:bg-accent aria-pressed:text-foreground"
                aria-label={url}
              >
                {parsed
                  ? `${new URL(url).hostname} · ${parsed.channelId} · ${new Date(Number(parsed.ts) * 1000).toLocaleDateString()}`
                  : url}
              </button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Unlink ${url}`}
                disabled={saving}
                onClick={() => void save(links.filter((link) => link !== url))}
              >
                <UnlinkIcon className="size-3.5" />
              </Button>
            </div>
          );
        })}
      </div>
      {activeUrl ? (
        <SlackConversation key={activeUrl} threadRef={threadRef} url={activeUrl} />
      ) : null}
    </div>
  );
}
