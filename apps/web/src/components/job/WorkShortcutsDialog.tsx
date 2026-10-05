import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Kbd, KbdGroup } from "../ui/kbd";

const SHORTCUTS: ReadonlyArray<readonly [keys: ReadonlyArray<string>, action: string]> = [
  [["J", "↓"], "Next item"],
  [["K", "↑"], "Previous item"],
  [["Enter"], "Open the first item"],
  [["Esc"], "Close the item"],
  [["E"], "Done"],
  [["I"], "Ignore"],
  [["S"], "Snooze…"],
  [["P"], "Pin or unpin"],
  [["T"], "Plan for today"],
  [["F"], "Follow the Slack thread"],
  [["R"], "Reply"],
  [["Z"], "Undo"],
  [["/"], "Search"],
  [["?"], "Show shortcuts"],
];

/** The Work page's keys, from `?` or the page menu. */
export function WorkShortcutsDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            On the Work page, outside text fields. On a row's status dot, ⌘/Ctrl-click marks it done
            and ⇧-click ignores it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
            {SHORTCUTS.map(([keys, action]) => (
              <div key={action} className="contents">
                <dt>
                  <KbdGroup>
                    {keys.map((key) => (
                      <Kbd key={key}>{key}</Kbd>
                    ))}
                  </KbdGroup>
                </dt>
                <dd className="text-muted-foreground">{action}</dd>
              </div>
            ))}
          </dl>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
