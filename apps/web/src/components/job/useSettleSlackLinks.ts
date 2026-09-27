import { type EnvironmentId, parseSlackThreadUrl } from "@t3tools/contracts";
import { useCallback } from "react";

import { slackEnvironment } from "../../state/slack";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";

/** The tick others see in Slack, and one of the reactions that count as done. */
const DONE_REACTION = "white_check_mark";

/**
 * Closes out the Slack conversations a thread is linked to: done on the Work page, and ✅ on
 * each in Slack, so the people there see it is handled. Cmd-clicking Settle runs it.
 */
export function useSettleSlackLinks() {
  const setDismissed = useAtomCommand(slackEnvironment.setDismissed, { reportFailure: false });
  const setReaction = useAtomCommand(slackEnvironment.setReaction, { reportFailure: false });
  return useCallback(
    (environmentId: EnvironmentId, links: ReadonlyArray<string>) => {
      const refs = links.flatMap((link) => {
        const parsed = parseSlackThreadUrl(link);
        return parsed ? [{ channelId: parsed.channelId, ts: parsed.ts }] : [];
      });
      if (refs.length === 0) return;
      void Promise.all(
        refs.flatMap((ref) => [
          setDismissed({ environmentId, input: { ...ref, dismissed: true } }),
          setReaction({ environmentId, input: { ...ref, name: DONE_REACTION, reacted: true } }),
        ]),
      ).then((results) => {
        const failed = results.some((result) => result._tag === "Failure");
        toastManager.add(
          failed
            ? { type: "error", title: "Could not mark the Slack conversation done" }
            : {
                type: "success",
                title:
                  refs.length === 1
                    ? "Marked the Slack conversation done"
                    : `Marked ${refs.length} Slack conversations done`,
              },
        );
      });
    },
    [setDismissed, setReaction],
  );
}
