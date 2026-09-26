# Work

On web or desktop, open **Work** from the sidebar or the command palette. **Linked work** brings your T3 threads,
their linked pull requests, and linked Slack conversations together across connected environments.
Use **Needs me** for agent questions, approvals, errors, failing PR checks, merge conflicts, and
requested changes. **In progress**, **Waiting**, and **Done** show the other work; choose a thread,
PR, or Slack link to continue in its source. PR status includes the time it last synced.
Link a PR from a T3 thread using **Link pull request** in the command palette; created PRs link
automatically.

The **Slack inbox** below shows threads you follow and new threads from channels you are in. It is
where you can start work from Slack. Slack follow and dismiss actions stay in that inbox.

## Connect Slack

T3 Code signs in through a Slack app you own, so no shared app or client secret is involved and
the token stays on your T3 Code server.

1. Choose **Create Slack app**. Slack opens with the permissions and sign-in settings filled in;
   pick your workspace and create it. Some workspaces need an admin to approve the app.
2. Copy the **Client ID** from the app's Basic Information page, paste it into T3 Code, and choose
   **Sign in with Slack**.

If your browser is not on the same machine as the T3 Code server, Slack's final page will not load
after you approve. Copy that page's full address and paste it into T3 Code to finish.

Disconnect from the **…** menu on the Work page. Disconnecting also revokes the token in Slack.

## What you see

The feed shows conversations started in the last day in your public channels, private channels,
and group messages, newest first. Expand a thread to read its replies, and add or remove reactions
from T3 Code. Direct messages are not included.

Busy channels are checked every 30 seconds and quiet ones less often, within Slack's rate limits.
If Slack asks T3 Code to slow down, the page shows when checking resumes.

Use **Channels** beside New threads to exclude channels from the feed. Excluded channels are not
checked for new threads; threads you follow in them still appear under Following. Use **Dismiss**
to hide one new thread, and **Show dismissed** to restore it.

## Follow threads with 👀

React to a Slack message with 👀, from T3 Code or from Slack itself, and its thread appears under
**Following** in the Slack inbox on the Work page. Following works anywhere in your workspace, including
direct messages and threads older than the feed window, and it stays until you remove the
reaction. Marking a reply follows its parent thread.
Choose **Unfollow** on the Work page to remove your 👀 reactions from that conversation.

Choose **Start thread** on a followed thread and pick the project folder to work in. The new
thread opens as a draft; when you send the first message it is created already linked to the
Slack conversation, so the sidebar shows the Slack icon and the **Slack threads** panel opens the
conversation beside your work. Threads already started from a followed thread are listed on it,
so you can jump back or start another.

## Thread owners

Every thread has an owner. You own the threads you create. To hand one to a Slack member, choose
**Assign owner…** from the thread's menu in the sidebar or the chat header, or run
**Assign thread owner…** from the command palette. The picker lists **You** and the members of
the connected Slack workspace; the owner's avatar shows on the thread in the sidebar. Choosing
**You** takes the thread back. Owners are a label for you to organize by; they do not share the
thread with anyone.

## Link Slack conversations to a T3 thread

On web and desktop, open **Slack threads** from the right panel’s **+** menu, or choose
**Link or open Slack threads** in the command palette. Paste a Slack message link to save it
with the current T3 thread. Links to replies open their parent conversation.

Select a saved link to read the conversation beside your work. The sidebar’s Slack icon reopens
these links. Refresh to fetch new replies, or unlink a conversation when it is no longer relevant.
The environment must be connected to the same Slack workspace. For files or conversations longer
than 200 messages, open the link in Slack. Native mobile does not yet have this panel.
