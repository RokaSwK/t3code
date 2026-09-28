import { useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { workCalendar } from "~/state/workCalendar";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { useNowMinute } from "~/hooks/useNowMinute";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { localWorkDate } from "./workRecap";

export function useWorkCalendar(environmentId: EnvironmentId | null) {
  const minute = useNowMinute();
  const day = localWorkDate(new Date(`${minute}:00Z`));
  const start = new Date(`${day}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const query = useEnvironmentQuery(
    environmentId
      ? workCalendar.read({
          environmentId,
          input: { date: day, start: start.toISOString(), end: end.toISOString() },
        })
      : null,
  );
  return {
    result: query.data,
    error: query.error,
    loading: query.isPending,
    refresh: query.refresh,
  };
}

export function WorkCalendarSettings({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const calendar = useWorkCalendar(environmentId);
  const save = useAtomCommand(workCalendar.set, { reportFailure: false });
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function connect(value: string | null) {
    setPending(true);
    setError(null);
    const result = await save({ environmentId, input: { url: value } });
    if (result._tag === "Success") {
      setUrl("");
      calendar.refresh();
    } else setError("Could not save this connection. Use Google's secret address in iCal format.");
    setPending(false);
  }
  return (
    <div className="space-y-3 p-3 sm:p-4">
      <p className="text-sm text-muted-foreground">
        Show today's meetings alongside your work plan. In Google Calendar settings, choose your
        calendar → Integrate calendar → Secret address in iCal format. The address is stored
        privately on your server and only used to read events.
      </p>
      <a
        className="text-sm underline"
        href="https://calendar.google.com/calendar/u/0/r/settings"
        target="_blank"
        rel="noreferrer"
      >
        Open Google Calendar settings
      </a>
      <p className="text-sm">
        {calendar.loading
          ? "Checking calendar…"
          : calendar.error
            ? "Calendar connection unavailable"
            : calendar.result?.connected
              ? "Calendar connected"
              : "No calendar connected"}
      </p>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void connect(url.trim());
        }}
      >
        <div className="min-w-48 flex-1">
          <Input
            type="password"
            autoComplete="off"
            aria-label="Secret iCal address"
            placeholder="Paste Google’s secret iCal address"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </div>
        <Button type="submit" size="sm" disabled={pending || !url.trim()}>
          {calendar.result?.connected ? "Replace" : "Connect"}
        </Button>
        {calendar.result?.connected || calendar.error ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => void connect(null)}
          >
            Disconnect
          </Button>
        ) : null}
      </form>
      {error || calendar.error ? (
        <p role="alert" className="text-sm text-destructive">
          {error ?? calendar.error}
        </p>
      ) : null}
    </div>
  );
}
