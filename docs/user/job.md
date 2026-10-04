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
PR is open. **Waiting** means you replied last or a PR is waiting on checks or review. Posts by
apps, such as CI or GitHub notifications, don't count as replies.

**Mentions** lists messages from the last two weeks that tag you and that you have not answered,
in conversations that are not already in your work. Writing later in the conversation (anywhere
later in a direct message) or reacting to the message answers it. Choose **Done** to clear one
yourself; a newer mention brings the conversation back.

A conversation is **Done** when anyone reacts to it with a tick (✅, ✔️, or ☑️), when every PR
it links to is merged or closed, or after three quiet days when you or Devin had the last word or
nobody replied. Choose **Done** to mark any other conversation yourself; a new reply from someone
else brings it back. **Not done** undoes your own mark. **Done**, **Ignore**, and **Unfollow**
also offer **Undo** for a few seconds.

Choose **Ignore** on an item to hide it without counting it as completed. Restore it from
**… → Ignored work**. Linked Slack messages and GitHub PRs stay together when ignored.

## Standups and weekly demos

Open **Recap** in Work for what you finished since your last workday (Friday, on a Monday), with
today's plan and meetings, or for this week's work in the weekly demo view. Finished work is grouped
into features under areas like Support or Mobile, so a PR, the thread that wrote it, and the Slack
request behind it sit together; expand a feature to see each item. Areas and features are ordered
by size, biggest first: lines changed in your PRs (not tests, generated files, or lockfiles) and
messages in the Slack conversation, so one large change ranks above many small ones. Chores fold
into **Smaller things**. The **Text generation model** from **Settings → General** names the
features and writes a short summary on top. The small numbers in the summary open the feature they
refer to.

Features are kept: new work joins the features it belongs to, so the recap reads the same each time
you open it and the daily and weekly views agree. The first recap of a busy week takes a minute or
two to group; later opens are instant. The refresh button next to the summary groups the period again
from scratch and rewrites the summary.

Choose **Plan for today** on work items to build your daily plan. In the weekly view, star the work
you want to demo. **Copy** puts the summary and the grouped, linked list on your clipboard.

The recap counts merged PRs, settled T3 threads that changed files, and conversations you marked
done when you started them or worked on them in a thread or PR. Questions, quiet conversations,
and channel posts you only dismissed are not counted. GitHub history uses your server's signed-in `gh` account and
Work's organization filter; up to 100 recent merged PRs are available.

To include today's meetings, go to **Settings → Work → Google Calendar**. In Google Calendar's
settings, select your calendar, then **Integrate calendar → Secret address in iCal format**. Paste
that address into Work and connect. Work reads events only; it cannot create or change meetings.
You can replace or disconnect the calendar in the same settings. Dates use your local timezone.

## Working on a conversation

Choose **Start thread** to work on a conversation in T3. The new thread opens as a draft in a new
worktree, already linked to the Slack conversation, with the message quoted in the composer; its
agent can read the whole conversation. It shows on the conversation here, and the **Slack
threads** panel opens the conversation beside your work. When you are done, ⌘-click **Settle** on
the thread in the sidebar to also mark its Slack conversation done and react ✅ in Slack. **Unfollow** in the **…** menu removes your 👀
reactions.

To hand a conversation to someone, choose **Assign owner…** from its **…** menu and pick a
Slack member. It moves to **Watching**, where you still see its updates and status, but it no
longer counts in **Needs me**, **In progress**, or **Waiting**. Choose **Take back** to make it
yours again.

T3 work that is not tied to one of your conversations is under **Other work**. Choose **Choose
folders…** from the page's **…** menu to pick which project folders it comes from; this choice is
saved on each connected server. Link a PR from a T3 thread using **Link pull request** in the
command palette; created PRs link automatically.

Pull requests from GitHub join your work too. A pull request waiting for your review is in
**Needs me**. Your own open pull requests wait for review, and need you when checks fail, changes
are requested, there is a merge conflict, or they are approved and ready to merge. Pull requests
linked from a conversation get the same details. They are read with the GitHub CLI, every few
minutes. To leave out an organization, such as a side project, turn it off under **Settings →
Work → GitHub**.

To answer a conversation, write in **Reply** in its detail and choose **Send**; it posts in the
Slack thread as you. What you type is kept as a draft until you send or discard it, and the Work
agent can draft replies for you to review. Rows with a draft show a pencil.

When a conversation is yours but blocked on someone, such as a reviewer, choose **Waiting on…**
from its **…** menu. It shows as **Waiting** until someone else replies, then comes back to
**Needs me**. A conversation with an open pull request where you or Devin had the last word also
counts as waiting for review.

Use **Wait for merge** beside a linked T3 thread when your part is finished. The conversation
and thread move to **Waiting** together, with 🕒 in Slack. All linked PRs merging settles the
thread and replaces 🕒 with ✅; PR problems wake it for your attention. **Wake** cancels the wait.

## Work agent

The Work agent is a T3 thread that sees your work the way this page does and can act on it. It
reads your conversations, Devin sessions, pull requests, and other T3 threads; it can follow,
mark done, hand off, or mark waiting; it drafts Slack replies for you to send; and it can start
or message other T3 threads, asking you first. It never posts in Slack itself.

Choose **Work agent** at the top of the page. The first time, it starts a thread in your Work
folder with a triage prompt ready to send; after that it opens the same thread with a prompt to
triage again. Choose its folder in **Settings → Work → Work agent**. Every thread has the Work
tools, so any agent can read and act on your work, not only the Work agent. Turn on **Tell the Work agent about new
items** to have it look into new **Needs me** items as they arrive, at most every 15 minutes.

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

Finding Devin threads and mentions uses Slack search, sending replies needs permission to post, and image
previews need file access. When a permission is missing, **Settings → Work** asks you to sign in again.

## New in your channels

Below your work, T3 Code lists conversations started in the last day in the channels you choose,
newest first. No channels are read until you pick them: choose **Choose channels…** in the page's
**…** menu and check the public channels, private channels, and group messages to watch. Select a conversation to read it, then choose **Follow**
to make it yours, **Start thread** to follow it and start work, or **Done** to clear it. Cleared
threads are one click away under **Show cleared**. Direct messages are not included.

Busy channels are checked every 30 seconds and quiet ones less often, within Slack's rate limits.
If Slack asks T3 Code to slow down, the page shows when checking resumes. Conversations you follow
appear in your work whether or not their channel is chosen.

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

### Live updates

By default T3 Code checks Slack every few minutes. With live updates, Slack sends changes to your
conversations as they happen, and they show within seconds. Under **Settings → Work → Live
updates**, choose **Copy manifest**, paste it into your Slack app's **App Manifest** page, and
save. That turns on Socket Mode and the message and reaction events. Then, on the app's **Basic
Information** page, generate an app-level token with the `connections:write` scope and paste it
into T3 Code. Slack is still checked every 15 minutes in case something was missed, and if the
connection drops, T3 Code goes back to checking every few minutes until it reconnects.

Disconnect in **Settings → Work**. Disconnecting also revokes the token in Slack. To start a fresh
inbox, choose **Reset Slack inbox** from the **…** menu on the Work page. This clears threads you
marked done and shows only conversations started after the reset. Existing
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
The environment must be connected to the same Slack workspace. Images open inline and can be
enlarged. If your Slack connection predates image support, sign in again in **Settings → Work**
to grant file access. For other files or conversations longer than 200 messages, open the link
in Slack. Native mobile does not yet have this panel.
