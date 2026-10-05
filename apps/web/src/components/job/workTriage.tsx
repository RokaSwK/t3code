import { SLACK_FOLLOW_REACTION } from "@t3tools/contracts";
import { withWorkSnooze, withoutWorkSnooze, workSnoozePresets } from "@t3tools/shared/workTriage";
import { useMemo, type ReactElement, type ReactNode } from "react";
import { create } from "zustand";

import {
  useClientSettings,
  usePrimarySettingsAvailable,
  useUpdatePrimarySettings,
} from "~/hooks/useSettings";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { primaryServerSettingsAtom } from "~/state/server";
import { slackEnvironment } from "~/state/slack";
import { useAtomCommand } from "~/state/use-atom-command";
import { isMacPlatform } from "~/lib/utils";

import { requestCustomSnooze } from "../CustomSnoozeDialog";
import { snoozeWakeDescription } from "../Sidebar.snooze";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuShortcut, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import type { WorkSelection } from "./WorkDetail";
import {
  slackMessageSummary,
  slackWorkItemKeys,
  workItemKeys,
  workItemTitle,
  workMatchesMarks,
} from "./workGroups";
import { localWorkDate } from "./workRecap";
import { showWorkUndoToast } from "./workUndo";

interface SlackRef {
  readonly channelId: string;
  readonly ts: string;
}

/** What the triage actions need to know about one item on the Work page. */
export interface WorkItemRef {
  readonly keys: ReadonlyArray<string>;
  readonly title: string;
  /** The Slack thread to mark done; null where done is not up to the user (PRs, T3 work). */
  readonly done: SlackRef | null;
  /** A Slack thread that is not yours yet, to follow. */
  readonly follow: SlackRef | null;
}

export function workItemOf(selection: WorkSelection): WorkItemRef {
  if (selection.kind === "new" || selection.kind === "mention") {
    const thread = selection.kind === "new" ? selection.thread : selection.mention.thread;
    const ref = { channelId: thread.channelId, ts: thread.ts };
    return {
      keys: slackWorkItemKeys(thread),
      title: slackMessageSummary(thread.markdown) || "Work item",
      done: selection.kind === "new" && selection.cleared ? null : ref,
      follow: ref,
    };
  }
  const { group } = selection;
  const conversation = group.conversation;
  return {
    keys: workItemKeys(group),
    title: workItemTitle(group),
    done:
      conversation && !group.markedDone && group.status !== "done"
        ? { channelId: conversation.channelId, ts: conversation.ts }
        : null,
    follow: null,
  };
}

const isMac = typeof navigator !== "undefined" && isMacPlatform(navigator.platform);

/** The status dot's tooltip line for its modifier clicks. */
export function workDotHint(canDone: boolean): string {
  return canDone ? `${isMac ? "⌘" : "Ctrl"}-click: Done · ⇧-click: Ignore` : "⇧-click: Ignore";
}

/**
 * Ignore, snooze, pin, plan, done, and follow, each written against the latest settings so a
 * change made elsewhere in the meantime is kept. Hiding changes offer an undo.
 */
export function useWorkTriage() {
  const update = useUpdatePrimarySettings();
  const available = usePrimarySettingsAvailable();
  const environmentId = usePrimaryEnvironmentId();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const setDismissed = useAtomCommand(slackEnvironment.setDismissed, { reportFailure: false });
  const setReaction = useAtomCommand(slackEnvironment.setReaction, { reportFailure: false });
  return useMemo(() => {
    const latest = () => appAtomRegistry.get(primaryServerSettingsAtom);
    const setDone = (ref: SlackRef, dismissed: boolean) =>
      environmentId === null
        ? Promise.resolve({ _tag: "Failure" as const })
        : setDismissed({ environmentId, input: { ...ref, dismissed } });
    const failed = (title: string) => toastManager.add({ type: "error", title });
    return {
      available,
      ignore(item: WorkItemRef) {
        const mark = { keys: [...item.keys], title: item.title, at: Date.now() };
        update({ workIgnoredItems: [...(latest().workIgnoredItems ?? []), mark] });
        showWorkUndoToast("Ignored", () =>
          update({
            workIgnoredItems: (latest().workIgnoredItems ?? []).filter(
              (entry) => entry.at !== mark.at,
            ),
          }),
        );
      },
      snooze(item: WorkItemRef, until: number) {
        const now = Date.now();
        const before = latest().workSnoozedItems ?? [];
        const replaced = before.filter(
          (entry) => entry.until > now && workMatchesMarks(item.keys, [entry]),
        );
        const mark = { keys: [...item.keys], title: item.title, at: now, until };
        update({ workSnoozedItems: withWorkSnooze(before, mark, now) });
        const when = snoozeWakeDescription(
          new Date(until).toISOString(),
          new Date(),
          timestampFormat,
        );
        showWorkUndoToast(`Snoozed until ${when}`, () =>
          update({
            workSnoozedItems: [
              ...(latest().workSnoozedItems ?? []).filter((entry) => entry.at !== mark.at),
              ...replaced,
            ],
          }),
        );
      },
      unsnooze(keys: ReadonlyArray<string>) {
        update({
          workSnoozedItems: withoutWorkSnooze(latest().workSnoozedItems ?? [], keys, Date.now()),
        });
      },
      togglePin(item: WorkItemRef) {
        const pins = latest().workPinnedItems ?? [];
        update({
          workPinnedItems: workMatchesMarks(item.keys, pins)
            ? pins.filter((entry) => !workMatchesMarks(item.keys, [entry]))
            : [...pins, { keys: [...item.keys], title: item.title, at: Date.now() }],
        });
      },
      togglePlan(item: WorkItemRef) {
        const today = localWorkDate();
        const plan = latest().workDayPlan;
        const planned = plan?.date === today ? plan.items : [];
        update({
          workDayPlan: {
            date: today,
            items: workMatchesMarks(item.keys, planned)
              ? planned.filter((entry) => !workMatchesMarks(item.keys, [entry]))
              : [...planned, { keys: [...item.keys], title: item.title, at: Date.now() }],
          },
        });
      },
      markDone(item: WorkItemRef) {
        const ref = item.done;
        if (!ref) return;
        void setDone(ref, true).then((result) => {
          if (result._tag === "Failure") return failed("Could not update the conversation");
          showWorkUndoToast("Marked done", () => {
            void setDone(ref, false).then((undone) => {
              if (undone._tag === "Failure") failed("Could not update the conversation");
            });
          });
        });
      },
      follow(item: WorkItemRef) {
        const ref = item.follow;
        if (!ref || environmentId === null) return;
        void setReaction({
          environmentId,
          input: { ...ref, name: SLACK_FOLLOW_REACTION, reacted: true },
        }).then((result) => {
          if (result._tag === "Failure") failed("Could not follow the thread");
        });
      },
    };
  }, [update, available, environmentId, timestampFormat, setDismissed, setReaction]);
}

export type WorkTriage = ReturnType<typeof useWorkTriage>;

/** Which snooze menu is open, so the `s` shortcut can open the one for the selected item. */
const useOpenSnoozeMenu = create<{ readonly openFor: string | null }>(() => ({ openFor: null }));

export function openWorkSnoozeMenu(menuId: string) {
  useOpenSnoozeMenu.setState({ openFor: menuId });
}

/** Snooze choices behind `trigger`: later today, tomorrow, next week, or a picked date. */
export function WorkSnoozeMenu({
  menuId,
  trigger,
  children,
  onSnooze,
}: {
  readonly menuId: string;
  readonly trigger: ReactElement;
  readonly children: ReactNode;
  readonly onSnooze: (until: number) => void;
}) {
  const open = useOpenSnoozeMenu((state) => state.openFor === menuId);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  // Resolved when the menu opens, so "Later today" is relative to now.
  const presets = useMemo(() => (open ? workSnoozePresets(new Date()) : []), [open]);
  return (
    <Menu
      open={open}
      onOpenChange={(next) => {
        if (next) useOpenSnoozeMenu.setState({ openFor: menuId });
        else if (useOpenSnoozeMenu.getState().openFor === menuId) {
          useOpenSnoozeMenu.setState({ openFor: null });
        }
      }}
    >
      <MenuTrigger render={trigger}>{children}</MenuTrigger>
      <MenuPopup align="end">
        {presets.map((preset) => (
          <MenuItem key={preset.id} onClick={() => onSnooze(preset.until)}>
            {preset.label}
            <MenuShortcut>
              {snoozeWakeDescription(
                new Date(preset.until).toISOString(),
                new Date(),
                timestampFormat,
              )}
            </MenuShortcut>
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem
          onClick={async () => {
            const choice = await requestCustomSnooze();
            if (choice) onSnooze(Date.parse(choice.snoozedUntil));
          }}
        >
          Pick a date…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
