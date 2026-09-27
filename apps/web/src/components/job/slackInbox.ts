import { SLACK_DONE_REACTIONS, type SlackThread } from "@t3tools/contracts";

/**
 * Why a Slack thread no longer needs attention, or null while it still might: a tick reaction
 * on its root from anyone, or every PR it links merged or closed.
 */
export function slackThreadDoneReason(thread: SlackThread): string | null {
  if (thread.reactions.some((reaction) => SLACK_DONE_REACTIONS.has(reaction.name))) {
    return "Marked ✅ in Slack";
  }
  const requests = thread.pullRequests ?? [];
  if (requests.length === 0) return null;
  if (requests.every((request) => request.state === "merged")) {
    return requests.length === 1 ? "PR merged" : "PRs merged";
  }
  if (requests.every((request) => request.state === "merged" || request.state === "closed")) {
    return requests.length === 1 ? "PR closed" : "PRs merged or closed";
  }
  return null;
}
