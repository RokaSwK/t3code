# Job

Open **Job** from the sidebar or the command palette. For now it follows new Slack threads from
the channels you are in.

## Connect Slack

T3 Code signs in through a Slack app you own, so no shared app or client secret is involved and
the token stays on your T3 Code server.

1. Choose **Create Slack app**. Slack opens with the permissions and sign-in settings filled in;
   pick your workspace and create it. Some workspaces need an admin to approve the app.
2. Copy the **Client ID** from the app's Basic Information page, paste it into T3 Code, and choose
   **Sign in with Slack**.

If your browser is not on the same machine as the T3 Code server, Slack's final page will not load
after you approve. Copy that page's full address and paste it into T3 Code to finish.

Disconnect from the **…** menu on the Job page. Disconnecting also revokes the token in Slack.

## What you see

The feed shows conversations started in the last day in your public channels, private channels,
and group messages, newest first. Expand a thread to read its replies, and add or remove reactions
from T3 Code. Direct messages are not included.

Busy channels are checked every 30 seconds and quiet ones less often, within Slack's rate limits.
If Slack asks T3 Code to slow down, the page shows when checking resumes.
