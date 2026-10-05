import {
  AlarmClockIcon,
  CalendarPlusIcon,
  EyeOffIcon,
  PinIcon,
  PinOffIcon,
  RotateCcwIcon,
} from "lucide-react";
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
import { workMatchesMarks } from "./workGroups";
import { localWorkDate } from "./workRecap";
import { useWorkTriage, WorkSnoozeMenu, type WorkItemRef } from "./workTriage";

/** The detail panel's snooze menu, which `s` opens when the selected row is not on screen. */
export const DETAIL_SNOOZE_MENU = "detail";

/** Ignoring never marks a conversation or PR as completed. Plans are explicit and dated. */
export function WorkItemActions({
  item,
  onHide,
}: {
  readonly item: WorkItemRef;
  /** The item left the list: ignored or snoozed. */
  readonly onHide: () => void;
}) {
  const settings = usePrimarySettings();
  const triage = useWorkTriage();
  const today = localWorkDate();
  const planned = settings.workDayPlan?.date === today ? settings.workDayPlan.items : [];
  const isPlanned = workMatchesMarks(item.keys, planned);
  const isPinned = workMatchesMarks(item.keys, settings.workPinnedItems ?? []);
  return (
    <div className="flex flex-wrap gap-1">
      <Button
        disabled={!triage.available}
        size="xs"
        variant="ghost"
        onClick={() => triage.togglePlan(item)}
      >
        <CalendarPlusIcon />
        {isPlanned ? "Remove from today" : "Plan for today"}
      </Button>
      <Button
        disabled={!triage.available}
        size="xs"
        variant="ghost"
        onClick={() => triage.togglePin(item)}
      >
        {isPinned ? <PinOffIcon /> : <PinIcon />}
        {isPinned ? "Unpin" : "Pin"}
      </Button>
      <WorkSnoozeMenu
        menuId={DETAIL_SNOOZE_MENU}
        trigger={<Button disabled={!triage.available} size="xs" variant="ghost" />}
        onSnooze={(until) => {
          triage.snooze(item, until);
          onHide();
        }}
      >
        <AlarmClockIcon />
        Snooze
      </WorkSnoozeMenu>
      <Button
        disabled={!triage.available}
        size="xs"
        variant="ghost"
        onClick={() => {
          triage.ignore(item);
          onHide();
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
