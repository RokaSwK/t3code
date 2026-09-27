/**
 * Work settings - the Slack sign-in and Devin API key behind the Work page. Both belong to the
 * primary environment, which reads Slack and Devin for every client.
 *
 * @module WorkSettingsPanel
 */
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { DevinConnection, EnvironmentId, SlackConnection } from "@t3tools/contracts";
import { useState } from "react";

import { readLocalApi } from "~/localApi";
import { useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import {
  agentSessionSync,
  agentSessionSyncStatus,
  describeAgentSessionSync,
} from "~/state/agentSessionSync";
import { useServerConfigs } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { slackEnvironment, useSlackState } from "~/state/slack";
import { useAtomCommand } from "~/state/use-atom-command";

import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SlackConnectPanel } from "./SlackConnectPanel";

function SlackSettings({
  environmentId,
  connection,
}: {
  readonly environmentId: EnvironmentId;
  readonly connection: SlackConnection;
}) {
  const connect = useAtomCommand(slackEnvironment.connect, { reportFailure: false });
  const disconnect = useAtomCommand(slackEnvironment.disconnect);
  const [pending, setPending] = useState(false);
  if (connection.status !== "connected") {
    return (
      <div className="p-3 sm:p-4">
        <SlackConnectPanel environmentId={environmentId} connection={connection} />
      </div>
    );
  }
  const missingSearch = connection.missingScopes?.includes("search:read") === true;
  const signInAgain = () => {
    setPending(true);
    void connect({ environmentId, input: { clientId: connection.clientId } })
      .then((result) => {
        if (result._tag === "Success" && result.value.status === "authorizing") {
          void readLocalApi()?.shell.openExternal(result.value.authorizeUrl);
        }
      })
      .finally(() => setPending(false));
  };
  return (
    <>
      <SettingsRow
        id="slack-connection"
        title="Slack"
        description={`Connected to ${connection.teamName} as ${connection.userName}.`}
        control={
          <Button
            size="sm"
            variant="outline"
            onClick={() => void disconnect({ environmentId, input: {} })}
          >
            Disconnect
          </Button>
        }
      />
      <SettingsRow
        title="Sign in again"
        description={
          missingSearch
            ? "Needed to find your Devin threads: this sign-in is missing Slack search."
            : "Renews the sign-in and picks up permissions added since you connected."
        }
        control={
          <Button
            size="sm"
            variant={missingSearch ? "default" : "outline"}
            disabled={pending}
            onClick={signInAgain}
          >
            Sign in with Slack
          </Button>
        }
      />
    </>
  );
}

function DevinSettings({
  environmentId,
  devin,
}: {
  readonly environmentId: EnvironmentId;
  readonly devin: DevinConnection;
}) {
  const devinConnect = useAtomCommand(slackEnvironment.devinConnect, { reportFailure: false });
  const devinDisconnect = useAtomCommand(slackEnvironment.devinDisconnect);
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (devin.status === "connected") {
    return (
      <SettingsRow
        id="devin-api-key"
        title="Devin API key"
        description={devin.error ?? `Reading session status as ${devin.name}.`}
        control={
          <Button
            size="sm"
            variant="outline"
            onClick={() => void devinDisconnect({ environmentId, input: {} })}
          >
            Remove
          </Button>
        }
      />
    );
  }
  return (
    <SettingsRow
      id="devin-api-key"
      title="Devin API key"
      description={
        error ??
        devin.error ??
        "Shows whether each Devin session is working, waiting for you, or finished. Create a key in Devin's settings; it stays on this server."
      }
    >
      <form
        className="flex gap-2 px-3 pb-3 sm:px-4"
        onSubmit={(event) => {
          event.preventDefault();
          setPending(true);
          setError(null);
          void devinConnect({ environmentId, input: { apiKey } }).then((result) => {
            setPending(false);
            if (result._tag === "Failure") {
              const failure = squashAtomCommandFailure(result);
              setError(
                failure instanceof Error ? failure.message : "Devin did not accept the key.",
              );
              return;
            }
            setApiKey("");
          });
        }}
      >
        <Input
          aria-label="Devin API key"
          className="flex-1"
          type="password"
          autoComplete="off"
          placeholder="cog_…"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
        <Button size="sm" type="submit" disabled={pending || apiKey.trim().length < 8}>
          Save
        </Button>
      </form>
    </SettingsRow>
  );
}

/** Codex and Claude app sessions arriving here as threads, automatically or on request. */
function AgentSessionImportSettings({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const configs = useServerConfigs();
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const sync = useAtomCommand(agentSessionSync, { reportFailure: false });
  const status = useEnvironmentQuery(agentSessionSyncStatus({ environmentId, input: {} }));
  const [pending, setPending] = useState(false);
  const autoImport = configs.get(environmentId)?.settings.agentSessionAutoImport !== false;
  const last = status.data;
  const running = pending || last?.running === true;
  const summary = running
    ? "Looking for new sessions…"
    : last?.lastRunAt
      ? `${last.error ?? describeAgentSessionSync(last.lastResult ?? { addedThreads: 0, createdProjects: 0 })} · ${formatRelativeTimeLabel(last.lastRunAt)}`
      : "Adds a thread for each Codex and Claude app session not here yet. Existing threads are never changed.";
  return (
    <>
      <SettingsRow
        id="agent-session-auto-import"
        title="Import new sessions automatically"
        description="Every few minutes, including projects for repositories the apps worked in."
        control={
          <Switch
            aria-label="Import new sessions automatically"
            checked={autoImport}
            onCheckedChange={(checked) => updateSettings({ agentSessionAutoImport: checked })}
          />
        }
      />
      <SettingsRow
        id="agent-session-import-now"
        title="Import now"
        description={summary}
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={running}
            onClick={() => {
              setPending(true);
              void sync({ environmentId, input: {} }).then((result) => {
                setPending(false);
                status.refresh();
                toastManager.add(
                  result._tag === "Success"
                    ? { type: "success", title: describeAgentSessionSync(result.value) }
                    : { type: "error", title: "Could not import sessions" },
                );
              });
            }}
          >
            Import now
          </Button>
        }
      />
    </>
  );
}

export function WorkSettingsPanel() {
  const environmentId = usePrimaryEnvironmentId();
  const state = useSlackState(environmentId);
  return (
    <SettingsPageContainer>
      <SettingsSection id="slack" title="Slack">
        {environmentId === null ? (
          <p className="p-4 text-sm text-muted-foreground">
            Slack connects through this device's own T3 Code server.
          </p>
        ) : state === null ? (
          <Skeleton className="m-4 h-16" />
        ) : (
          <SlackSettings environmentId={environmentId} connection={state.connection} />
        )}
      </SettingsSection>
      <SettingsSection id="agent-sessions" title="Codex and Claude apps">
        {environmentId === null ? (
          <Skeleton className="m-4 h-16" />
        ) : (
          <AgentSessionImportSettings environmentId={environmentId} />
        )}
      </SettingsSection>
      <SettingsSection id="devin" title="Devin">
        {environmentId === null || state === null ? (
          <Skeleton className="m-4 h-16" />
        ) : (
          <DevinSettings environmentId={environmentId} devin={state.devin} />
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
