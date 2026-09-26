import {
  SLACK_OAUTH_REDIRECT_URI,
  slackCreateAppUrl,
  type EnvironmentId,
  type SlackConnection,
} from "@t3tools/contracts";
import { useState } from "react";

import { readLocalApi } from "~/localApi";
import { slackEnvironment } from "~/state/slack";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button, InlineButton } from "../ui/button";
import { Input } from "../ui/input";

const CLIENT_ID_PATTERN = /^\d+\.\d+$/;

function openExternal(url: string) {
  void readLocalApi()?.shell.openExternal(url);
}

/** Sign-in for a disconnected or authorizing Slack connection. */
export function SlackConnectPanel({
  environmentId,
  connection,
}: {
  readonly environmentId: EnvironmentId;
  readonly connection: Exclude<SlackConnection, { status: "connected" }>;
}) {
  const connect = useAtomCommand(slackEnvironment.connect, { reportFailure: false });
  const completeConnect = useAtomCommand(slackEnvironment.completeConnect, {
    reportFailure: false,
  });
  const cancelConnect = useAtomCommand(slackEnvironment.cancelConnect);
  const [clientId, setClientId] = useState(connection.clientId ?? "");
  const [showSetup, setShowSetup] = useState(false);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const error = localError ?? connection.error ?? null;

  if (connection.status === "authorizing") {
    return (
      <section className="flex flex-col gap-4 rounded-xl border bg-card p-5 text-card-foreground">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-medium">Finish signing in with Slack</h2>
          <p className="text-sm text-muted-foreground">
            Approve T3 Code in Slack. This page updates when you are done.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => openExternal(connection.authorizeUrl)}>
            Continue in Slack
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void cancelConnect({ environmentId, input: {} })}
          >
            Cancel
          </Button>
        </div>
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setPending(true);
            setLocalError(null);
            void completeConnect({ environmentId, input: { callbackUrl } })
              .then((result) => {
                if (result._tag === "Failure") {
                  setLocalError("That address did not finish sign-in. Start again if it expired.");
                }
              })
              .finally(() => setPending(false));
          }}
        >
          <label className="text-xs text-muted-foreground" htmlFor="slack-callback-url">
            Using T3 Code on another machine? After approving, Slack opens a page that will not
            load. Paste that page's full address here.
          </label>
          <div className="flex gap-2">
            <Input
              id="slack-callback-url"
              className="flex-1"
              placeholder={`${SLACK_OAUTH_REDIRECT_URI}?code=…`}
              value={callbackUrl}
              onChange={(event) => setCallbackUrl(event.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              type="submit"
              disabled={pending || !callbackUrl.startsWith(SLACK_OAUTH_REDIRECT_URI)}
            >
              Finish
            </Button>
          </div>
        </form>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </section>
    );
  }

  const validClientId = CLIENT_ID_PATTERN.test(clientId.trim());
  const startSignIn = () => {
    if (!validClientId) return;
    setPending(true);
    setLocalError(null);
    void connect({ environmentId, input: { clientId: clientId.trim() } })
      .then((result) => {
        if (result._tag === "Failure") {
          setLocalError("Could not start Slack sign-in.");
          return;
        }
        if (result.value.status === "authorizing") {
          openExternal(result.value.authorizeUrl);
        }
      })
      .finally(() => setPending(false));
  };
  // The server remembers the app; a sign-out or a lost token only needs the one click.
  if (connection.clientId && !showSetup) {
    return (
      <section className="flex flex-col gap-4 rounded-xl border bg-card p-5 text-card-foreground">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-medium">Connect Slack</h2>
          <p className="text-sm text-muted-foreground">
            Sign in again to follow threads and assign owners. Your Slack app is remembered.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" disabled={pending} onClick={startSignIn}>
            Sign in with Slack
          </Button>
          <InlineButton tone="muted" onClick={() => setShowSetup(true)}>
            Use a different Slack app
          </InlineButton>
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-5 rounded-xl border bg-card p-5 text-card-foreground">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">Connect Slack</h2>
        <p className="text-sm text-muted-foreground">
          Follow new threads from your channels here. T3 Code reads messages and reactions and can
          react for you. It signs in through your own Slack app, and the token stays on this server.
        </p>
      </div>
      <ol className="flex list-decimal flex-col gap-4 ps-5 text-sm">
        <li className="flex flex-col gap-2">
          <span>
            Create the app in Slack. The permissions and sign-in settings are filled in; pick your
            workspace and choose Create.
          </span>
          <div>
            <Button size="sm" variant="outline" onClick={() => openExternal(slackCreateAppUrl())}>
              Create Slack app
            </Button>
          </div>
        </li>
        <li className="flex flex-col gap-2">
          <span>
            Copy the Client ID from the app's Basic Information page and sign in. Your workspace may
            ask an admin to approve the app first.
          </span>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              startSignIn();
            }}
          >
            <Input
              aria-label="Slack app Client ID"
              className="flex-1"
              placeholder="Client ID, like 1234567890.1234567890"
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
            />
            <Button size="sm" type="submit" disabled={pending || !validClientId}>
              Sign in with Slack
            </Button>
          </form>
        </li>
      </ol>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </section>
  );
}
