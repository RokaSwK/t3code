import { CalendarPlusIcon, EyeOffIcon, RotateCcwIcon } from "lucide-react";
import type { SlackThread } from "@t3tools/contracts";
import {
  usePrimarySettings,
  usePrimarySettingsAvailable,
  useUpdatePrimarySettings,
} from "~/hooks/useSettings";
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
  workItemKeys,
  workItemTitle,
  workMatchesMarks,
  slackWorkItemKeys,
  slackMessageSummary,
  type WorkGroup,
} from "./workGroups";
import { localWorkDate } from "./workRecap";

/** Ignoring never marks a conversation or PR as completed. Plans are explicit and dated. */
export function WorkItemActions({
  group,
  thread,
  onIgnore,
}: {
  readonly group?: WorkGroup;
  readonly thread?: SlackThread;
  readonly onIgnore: () => void;
}) {
  const settings = usePrimarySettings();
  const update = useUpdatePrimarySettings();
  const available = usePrimarySettingsAvailable();
  const keys = group ? workItemKeys(group) : thread ? slackWorkItemKeys(thread) : [];
  const title = group
    ? workItemTitle(group)
    : thread
      ? slackMessageSummary(thread.markdown) || "Work item"
      : "Work item";
  const today = localWorkDate();
  const planned = settings.workDayPlan?.date === today ? settings.workDayPlan.items : [];
  const isPlanned = workMatchesMarks(keys, planned);
  return (
    <div className="flex flex-wrap gap-1">
      <Button
        disabled={!available}
        size="xs"
        variant="ghost"
        onClick={() =>
          update({
            workDayPlan: {
              date: today,
              items: isPlanned
                ? planned.filter((item) => !workMatchesMarks(keys, [item]))
                : [...planned, { keys, title, at: Date.now() }],
            },
          })
        }
      >
        <CalendarPlusIcon />
        {isPlanned ? "Remove from today" : "Plan for today"}
      </Button>
      <Button
        disabled={!available}
        size="xs"
        variant="ghost"
        onClick={() => {
          update({
            workIgnoredItems: [
              ...(settings.workIgnoredItems ?? []),
              { keys, title, at: Date.now() },
            ],
          });
          onIgnore();
        }}
      >
        <EyeOffIcon />
        Ignore
      </Button>
    </div>
  );
}

export function WorkIgnoredDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const settings = usePrimarySettings();
  const update = useUpdatePrimarySettings();
  const available = usePrimarySettingsAvailable();
  const ignored = settings.workIgnoredItems ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Ignored work</DialogTitle>
          <DialogDescription>
            Hidden from your work and summaries. Restore an item to see it again.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex max-h-96 flex-col gap-2 overflow-y-auto">
            {ignored.length === 0 ? (
              <p className="text-sm text-muted-foreground">No ignored work.</p>
            ) : (
              ignored.map((item, index) => (
                <div key={`${item.at}:${item.keys.join("|")}`} className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 text-sm">{item.title}</span>
                  <Button
                    disabled={!available}
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      update({ workIgnoredItems: ignored.filter((_, i) => i !== index) })
                    }
                  >
                    <RotateCcwIcon />
                    Restore
                  </Button>
                </div>
              ))
            )}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
