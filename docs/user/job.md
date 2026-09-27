# Tuyo Work

On web or desktop, open **Tuyo Work** from the sidebar or the command palette. The page is built
around your Slack conversations: the threads you follow with 👀, the Devin threads you started or
wrote in, and the threads you linked to a T3 thread. Each one shows the T3 threads, Devin sessions,
and pull requests working on it, across connected environments.

Connect Slack, and optionally Devin, in **Settings → Work**.

## Your work

The page lists your conversations grouped by what they need, newest first. Select one to read
it beside the list, with the Devin sessions, T3 threads, and pull requests working on it.

**Needs me** is where to start. A conversation needs you when someone else replied last, an
agent is waiting on you (a T3 approval, question, plan, or error, or a Devin session waiting for
input), a pull request has failing checks, a merge conflict, or requested changes, or Devin
replied or finished and you have not looked yet. **In progress** means an agent is working or a
PR is open. **Waiting** means you replied last or a PR is waiting on checks or review.

A conversation is **Done** when anyone reacts to it with a tick (✅, ✔️, or ☑️), when every PR
it links to is merged or closed, or after three quiet days when you or Devin had the last word or
nobody replied. Choose **Done** to mark any other conversation yourself; a new reply from someone
else brings it back. **Not done** undoes your own mark.

Choose **Start thread** to work on a conversation in T3. The new thread opens as a draft already
linked to the Slack conversation, so it shows on the conversation here, and the **Slack threads**
panel opens the conversation beside your work. **Unfollow** in the **…** menu removes your 👀
reactions.

To hand a conversation to someone, choose **Assign owner…** from its **…** menu and pick a
Slack member. It moves to **Watching**, where you still see its updates and status, but it no
longer counts in **Needs me**, **In progress**, or **Waiting**. Choose **Take back** to make it
yours again.

T3 work that is not tied to one of your conversations is under **Other work**. Choose **Choose
folders…** from the page's **…** menu to pick which project folders it comes from; this choice is
saved on each connected server. Link a PR from a T3 thread using **Link pull request** in the
command palette; created PRs link automatically.

Choose **Review with agent** to open a new T3 draft with the current work snapshot. Review and
send the prompt when you want a triage report. The agent is asked to investigate, identify
blockers, and suggest next actions without changing sources or sending messages.

## Codex and Claude apps

Sessions from the Codex and Claude apps, and their command-line tools, arrive as T3 threads on
their own every few minutes, with the name the app gave them. T3 Code also adds a project for
each repository those apps worked in during the last 30 days. It only adds threads: one already
here is never changed, even if you keep going in the app. Continue an imported thread here to
pick up the same session. Imported threads show the app's logo in the sidebar and the thread
header.

To import right away, choose **Import threads from Codex and Claude** in the command palette or
**Import now** in **Settings → Work**, where you can also turn automatic importing off.

## Devin

Devin threads show up on their own: any Slack thread where Devin works and you started it or
wrote in it, from the last 14 days, including your direct messages with Devin and automations
that post on your behalf. Each shows its Devin session; select it to open the session.

To see whether each session is working, waiting for you, or finished, add a Devin API key in
**Settings → Work**. Create the key in your Devin organization's settings. It stays on your T3
Code server. Without a key, T3 Code goes by Devin's messages in Slack instead.

Finding Devin threads uses Slack search. If you connected Slack before this was added,
**Settings → Work** asks you to sign in to Slack again.

## New in your channels

Below your work, T3 Code lists conversations started in the last day in your public channels,
private channels, and group messages, newest first. Select one to read it, then choose **Follow**
to make it yours, **Start thread** to follow it and start work, or **Done** to clear it. Cleared
threads are one click away under **Show cleared**. Direct messages are not included.

Busy channels are checked every 30 seconds and quiet ones less often, within Slack's rate limits.
If Slack asks T3 Code to slow down, the page shows when checking resumes. Use **Choose channels…**
in the **…** menu to exclude channels from this list; conversations you follow in them still
appear in your work.

## Connect Slack

T3 Code signs in through a Slack app you own, so no shared app or client secret is involved and
the token stays on your T3 Code server.

1. In **Settings → Work**, choose **Create Slack app**. Slack opens with the permissions and
   sign-in settings filled in; pick your workspace and create it. Some workspaces need an admin to
   approve the app.
2. Copy the **Client ID** from the app's Basic Information page, paste it into T3 Code, and choose
   **Sign in with Slack**.

If your browser is not on the same machine as the T3 Code server, Slack's final page will not load
after you approve. Copy that page's full address and paste it into T3 Code to finish. If Slack
refuses a permission when you sign in again, add it under **User Token Scopes** on your Slack
app's **OAuth & Permissions** page.

Disconnect in **Settings → Work**. Disconnecting also revokes the token in Slack. To start a fresh
inbox, choose **Reset Slack inbox** from the **…** menu on the Work page. This clears threads you
marked done and channel exclusions and shows only conversations started after the reset. Existing
T3 threads, PR links, and Slack reactions remain as they are.

Pull request status is read with the GitHub CLI on the T3 Code server, so it needs `gh` signed in
to an account that can see the repository.

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
with the current T3 thread. Links to replies open their parent conversation. Linking also
follows the conversation with 👀, so it appears in your work.

Select a saved link to read the conversation beside your work. The sidebar’s Slack icon reopens
these links. Refresh to fetch new replies, or unlink a conversation when it is no longer relevant.
The environment must be connected to the same Slack workspace. For files or conversations longer
than 200 messages, open the link in Slack. Native mobile does not yet have this panel.
