import type { EnvironmentId, SlackChannel, SlackState } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { slackEnvironment } from "../../state/slack";
import { useAtomCommand } from "../../state/use-atom-command";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";

export function ChannelExclusionsDialog({
  environmentId,
  state,
  open,
  onOpenChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly state: SlackState;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const getChannels = useAtomCommand(slackEnvironment.getChannels, { reportFailure: false });
  const setExcluded = useAtomCommand(slackEnvironment.setChannelExcluded, {
    reportFailure: false,
  });
  const [channels, setChannels] = useState<ReadonlyArray<SlackChannel> | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [search, setSearch] = useState("");
  const [changing, setChanging] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    if (!open || state.sync.availableChannelCount === 0) return;
    let cancelled = false;
    void getChannels({ environmentId, input: {} }).then((result) => {
      if (cancelled) return;
      if (result._tag === "Failure") {
        setLoadFailed(true);
      } else {
        setChannels(result.value);
        setLoadFailed(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, getChannels, open, state.sync.availableChannelCount]);

  const excluded = new Set(state.excludedChannelIds);
  const visible =
    state.sync.availableChannelCount === 0
      ? []
      : channels?.filter((channel) =>
          channel.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
        );
  const changeExcluded = (channelId: string, nextExcluded: boolean) => {
    setChanging((current) => new Set(current).add(channelId));
    void setExcluded({ environmentId, input: { channelId, excluded: nextExcluded } }).then(
      (result) => {
        setChanging((current) => {
          const next = new Set(current);
          next.delete(channelId);
          return next;
        });
        if (result._tag === "Failure") {
          toastManager.add({ type: "error", title: "Could not update channel exclusion" });
        }
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Exclude channels</DialogTitle>
          <DialogDescription>
            Checked channels are left out of New threads. Threads you follow still appear in
            Following.
          </DialogDescription>
          <Input
            type="search"
            aria-label="Search channels"
            placeholder="Search channels"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-1 px-6 pb-6">
            {loadFailed ? (
              <p className="text-sm text-destructive">
                Could not load channels. Close and try again.
              </p>
            ) : visible === undefined ? (
              <p className="text-sm text-muted-foreground">Loading channels…</p>
            ) : visible.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {search ? "No matching channels." : "Channels appear here after Slack syncs."}
              </p>
            ) : (
              visible.slice(0, 100).map((channel) => (
                <div
                  key={channel.id}
                  className="flex min-w-0 items-center gap-3 rounded-md px-2 py-1.5"
                >
                  <Checkbox
                    id={`exclude-${channel.id}`}
                    checked={excluded.has(channel.id)}
                    disabled={changing.has(channel.id)}
                    onCheckedChange={(checked) => changeExcluded(channel.id, checked === true)}
                  />
                  <label
                    htmlFor={`exclude-${channel.id}`}
                    className="min-w-0 flex-1 cursor-pointer truncate text-sm"
                  >
                    {channel.kind === "channel" ? "#" : ""}
                    {channel.name}
                  </label>
                </div>
              ))
            )}
            {visible && visible.length > 100 ? (
              <p className="px-2 text-xs text-muted-foreground">
                Showing the first 100 of {visible.length} channels. Search to narrow the list.
              </p>
            ) : null}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
