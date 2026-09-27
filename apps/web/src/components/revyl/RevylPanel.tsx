/**
 * Revyl panel - a Revyl cloud device, live, in the right panel. The screen plays over WebRTC
 * straight from Revyl; clicks, drags, and typing go to the device through the environment's
 * `revyl` CLI. Sessions an agent starts with the CLI show up here to watch.
 *
 * @module RevylPanel
 */
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, RevylInput, RevylPlatform, RevylSession } from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  CircleIcon,
  ExternalLinkIcon,
  HouseIcon,
  RefreshCwIcon,
  SmartphoneIcon,
  SquareIcon,
} from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";

import { readLocalApi } from "~/localApi";
import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { revylInput, revylStart, revylState, revylStop } from "~/state/revyl";
import { useAtomCommand } from "~/state/use-atom-command";

import { PreviewPanelShell, type PreviewPanelMode } from "../preview/PreviewPanelShell";
import { Button } from "../ui/button";
import { DiscoveryList, DiscoveryListRow } from "../ui/discovery-list";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { revylGesture } from "./revylGestures";
import { playWhep } from "./whep";

/** Sessions an agent starts elsewhere appear within this long. */
const POLL_MS = 10_000;
/** Keys typed within this window go to the device as one text entry. */
const TYPE_FLUSH_MS = 300;

const platformName = (platform: RevylPlatform) => (platform === "ios" ? "iPhone" : "Android");

const failureMessage = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const cause = squashAtomCommandFailure(result);
  return cause instanceof Error ? cause.message : "Revyl did not accept the request.";
};

function openExternal(url: string) {
  const api = readLocalApi();
  if (api) void api.shell.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

export function RevylPanel(props: {
  readonly mode: PreviewPanelMode;
  readonly environmentId: EnvironmentId;
  readonly visible: boolean;
}) {
  const { environmentId } = props;
  const query = useEnvironmentQuery(revylState({ environmentId, input: {} }));
  const start = useAtomCommand(revylStart, { reportFailure: false });
  const stop = useAtomCommand(revylStop, { reportFailure: false });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [starting, setStarting] = useState<RevylPlatform | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { refresh } = query;

  useEffect(() => {
    if (!props.visible) return;
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [props.visible, refresh]);

  const state = query.data;
  const sessions = state?._tag === "ready" ? state.sessions : [];
  const session = sessions.find((entry) => entry.sessionId === selectedId) ?? sessions[0] ?? null;

  const startDevice = (platform: RevylPlatform) => {
    setStarting(platform);
    setError(null);
    void start({ environmentId, input: { platform } }).then((result) => {
      setStarting(null);
      if (result._tag === "Failure") setError(failureMessage(result));
      else setSelectedId(result.value.sessionId);
      refresh();
    });
  };

  const stopDevice = (target: RevylSession) => {
    setError(null);
    void stop({ environmentId, input: { sessionId: target.sessionId } }).then((result) => {
      if (result._tag === "Failure") setError(failureMessage(result));
      setSelectedId(null);
      refresh();
    });
  };

  return (
    <PreviewPanelShell mode={props.mode}>
      {error ? (
        <div role="alert" className="border-b bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}
      {state === null ? (
        <div className="grid flex-1 place-items-center">
          {query.error ? (
            <p className="max-w-xs text-center text-sm text-muted-foreground">{query.error}</p>
          ) : (
            <Spinner />
          )}
        </div>
      ) : state._tag !== "ready" ? (
        <RevylMessage
          text={
            state._tag === "unavailable"
              ? state.reason
              : "Sign in to Revyl on the machine running T3 Code: revyl auth login"
          }
          onRetry={refresh}
        />
      ) : session && starting === null ? (
        <RevylDevice
          key={session.sessionId}
          environmentId={environmentId}
          session={session}
          sessions={sessions}
          onSelect={setSelectedId}
          onStop={() => stopDevice(session)}
          onError={setError}
        />
      ) : (
        <div className="flex size-full flex-col overflow-y-auto px-5 py-8 text-sm text-muted-foreground">
          <div className="mx-auto my-auto flex w-full max-w-md flex-col gap-4">
            <div className="space-y-1 text-center">
              <SmartphoneIcon className="mx-auto size-6 opacity-60" />
              <p className="text-foreground">Revyl cloud devices</p>
              <p>
                Start a device to use it here. Devices your agents start with the Revyl CLI show up
                on their own.
              </p>
            </div>
            <DiscoveryList>
              {(["ios", "android"] as const).map((platform) => (
                <DiscoveryListRow
                  key={platform}
                  icon={
                    <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border/60">
                      <SmartphoneIcon className="size-4" />
                    </span>
                  }
                  title={platformName(platform)}
                  description={
                    starting === platform
                      ? "Starting a cloud device… this can take a minute."
                      : `Start a ${platform === "ios" ? "iOS" : "Android"} device on Revyl`
                  }
                  disabled={starting !== null}
                  aria-label={`Start ${platformName(platform)}`}
                  onClick={() => startDevice(platform)}
                  action={
                    starting === platform ? (
                      <Spinner size="xs" />
                    ) : (
                      <span className="text-xs text-muted-foreground">Start</span>
                    )
                  }
                />
              ))}
            </DiscoveryList>
          </div>
        </div>
      )}
    </PreviewPanelShell>
  );
}

function RevylMessage({ text, onRetry }: { readonly text: string; readonly onRetry: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
      <SmartphoneIcon className="size-6 opacity-60" />
      <p className="max-w-xs select-text">{text}</p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Check again
      </Button>
    </div>
  );
}

type StreamState = "connecting" | "live" | "lost";

interface Ripple {
  readonly id: number;
  readonly x: number;
  readonly y: number;
}

/** One-shot ring where a tap landed; it expands and fades once, then is removed. */
function TapRipple({ ripple }: { readonly ripple: Ripple }) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setExpanded(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute size-10 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white/90 bg-white/20 transition-[scale,opacity] duration-500 ease-out",
        expanded ? "scale-150 opacity-0" : "scale-50 opacity-100",
      )}
      style={{ left: ripple.x, top: ripple.y }}
    />
  );
}

function RevylDevice(props: {
  readonly environmentId: EnvironmentId;
  readonly session: RevylSession;
  readonly sessions: ReadonlyArray<RevylSession>;
  readonly onSelect: (sessionId: string) => void;
  readonly onStop: () => void;
  readonly onError: (message: string | null) => void;
}) {
  const { environmentId, session, onError } = props;
  const send = useAtomCommand(revylInput, { reportFailure: false });
  const videoRef = useRef<HTMLVideoElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const [stream, setStream] = useState<StreamState>("connecting");
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(0);
  const [ripples, setRipples] = useState<ReadonlyArray<Ripple>>([]);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const press = useRef<{ clientX: number; clientY: number; at: number } | null>(null);
  const typed = useRef({ text: "", timer: 0 });
  const rippleId = useRef(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !session.whepUrl) return;
    let playback: { close: () => void } | null = null;
    let cancelled = false;
    setStream("connecting");
    playWhep({
      url: session.whepUrl,
      video,
      onState: (state) => {
        if (state === "connected") setStream("live");
        else if (state === "failed" || state === "disconnected") setStream("lost");
      },
    }).then(
      (started) => {
        if (cancelled) started.close();
        else playback = started;
      },
      () => {
        if (!cancelled) setStream("lost");
      },
    );
    return () => {
      cancelled = true;
      playback?.close();
    };
    // `attempt` reconnects on request.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [session.whepUrl, attempt]);

  // Inputs go one at a time so a tap never overtakes the text typed before it.
  const enqueue = (input: RevylInput) => {
    setPending((count) => count + 1);
    queue.current = queue.current.then(async () => {
      const result = await send({
        environmentId,
        input: { sessionId: session.sessionId, input },
      });
      setPending((count) => count - 1);
      onError(result._tag === "Failure" ? failureMessage(result) : null);
    });
  };

  const flushTyped = () => {
    window.clearTimeout(typed.current.timer);
    const text = typed.current.text;
    typed.current.text = "";
    if (text) enqueue({ _tag: "type", text });
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    press.current = { clientX: event.clientX, clientY: event.clientY, at: event.timeStamp };
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const start = press.current;
    press.current = null;
    const screen = screenRef.current;
    if (!start || !screen) return;
    const box = screen.getBoundingClientRect();
    const gesture = revylGesture({
      box,
      screen: { width: session.screenWidth, height: session.screenHeight },
      start,
      end: { clientX: event.clientX, clientY: event.clientY },
      heldMs: event.timeStamp - start.at,
    });
    flushTyped();
    enqueue(gesture);
    const id = ++rippleId.current;
    setRipples((current) => [
      ...current,
      { id, x: start.clientX - box.left, y: start.clientY - box.top },
    ]);
    window.setTimeout(
      () => setRipples((current) => current.filter((ripple) => ripple.id !== id)),
      600,
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Enter" || event.key === "Backspace") {
      event.preventDefault();
      if (event.key === "Backspace" && typed.current.text) {
        typed.current.text = typed.current.text.slice(0, -1);
        return;
      }
      flushTyped();
      enqueue({ _tag: "key", key: event.key === "Enter" ? "ENTER" : "BACKSPACE" });
      return;
    }
    if (event.key.length !== 1) return;
    event.preventDefault();
    typed.current.text += event.key;
    window.clearTimeout(typed.current.timer);
    typed.current.timer = window.setTimeout(flushTyped, TYPE_FLUSH_MS);
  };

  const ratio = session.screenWidth / session.screenHeight;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        {props.sessions.length > 1 ? (
          <Select
            value={session.sessionId}
            onValueChange={(value) => {
              if (value) props.onSelect(value);
            }}
          >
            <SelectTrigger size="xs" className="w-40" aria-label="Revyl device">
              <SelectValue>{platformName(session.platform)}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {props.sessions.map((entry) => (
                <SelectItem key={entry.sessionId} value={entry.sessionId}>
                  {platformName(entry.platform)} · {entry.sessionId.slice(0, 6)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : (
          <span className="text-sm font-medium">{platformName(session.platform)}</span>
        )}
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CircleIcon
            className={cn(
              "size-2",
              stream === "live"
                ? "fill-success text-success"
                : stream === "lost"
                  ? "fill-destructive text-destructive"
                  : "fill-muted-foreground/50 text-muted-foreground/50",
            )}
          />
          {stream === "live" ? "Live" : stream === "lost" ? "Disconnected" : "Connecting"}
        </span>
        {pending > 0 ? <Spinner size="xs" aria-label="Sending to the device" /> : null}
        <div className="ms-auto flex items-center gap-1">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Open in Revyl"
            onClick={() => openExternal(session.viewerUrl)}
          >
            <ExternalLinkIcon />
          </Button>
          <Button size="icon-xs" variant="ghost" aria-label="Stop device" onClick={props.onStop}>
            <SquareIcon />
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-4 [container-type:size]">
        <div
          className="relative overflow-hidden rounded-4xl border-4 border-foreground bg-black shadow-xl ring-1 ring-border dark:border-border"
          style={{
            aspectRatio: `${session.screenWidth} / ${session.screenHeight}`,
            width: `min(100cqw, 100cqh * ${ratio})`,
          }}
        >
          <div
            ref={screenRef}
            role="application"
            aria-label={`${platformName(session.platform)} screen: click to tap, drag to swipe, type to enter text`}
            tabIndex={0}
            className="absolute inset-0 cursor-pointer touch-none select-none outline-none"
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerCancel={() => {
              press.current = null;
            }}
            onKeyDown={onKeyDown}
            onBlur={flushTyped}
          >
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="pointer-events-none size-full object-contain"
            />
            {ripples.map((ripple) => (
              <TapRipple key={ripple.id} ripple={ripple} />
            ))}
            {stream !== "live" ? (
              <div className="absolute inset-0 grid place-items-center bg-black/60 text-xs text-white/80">
                {stream === "lost" || !session.whepUrl ? (
                  <div className="flex flex-col items-center gap-2">
                    <span>{session.whepUrl ? "Stream disconnected" : "No live stream yet"}</span>
                    <Button
                      size="xs"
                      variant="secondary"
                      onPointerDown={(event) => event.stopPropagation()}
                      onPointerUp={(event) => event.stopPropagation()}
                      onClick={() => setAttempt((value) => value + 1)}
                    >
                      <RefreshCwIcon />
                      Reconnect
                    </Button>
                  </div>
                ) : (
                  <Spinner />
                )}
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-center gap-1 border-t px-3 py-1.5">
        <Button size="xs" variant="ghost" onClick={() => enqueue({ _tag: "home" })}>
          <HouseIcon />
          Home
        </Button>
        {session.platform === "android" ? (
          <Button size="xs" variant="ghost" onClick={() => enqueue({ _tag: "back" })}>
            <ArrowLeftIcon />
            Back
          </Button>
        ) : null}
        <span className="ms-2 truncate text-xs text-muted-foreground">
          Click to tap · drag to swipe · type to enter text
        </span>
      </div>
    </div>
  );
}
