import type { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";

import { cn } from "../lib/utils";
import { useServerConfigs } from "../state/entities";
import { ClaudeAI, OpenAI } from "./Icons";
const PROVIDER_ICON_BY_PROVIDER: Record<string, typeof ClaudeAI> = { claudeAgent: ClaudeAI, codex: OpenAI };
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const IMPORTED_THREAD_PREFIX = "import:";

/** Threads imported from the Codex and Claude apps keep `import:<instance>:<session>` ids. */
export function importedThreadInstanceId(threadId: string): string | null {
  if (!threadId.startsWith(IMPORTED_THREAD_PREFIX)) return null;
  const instanceId = threadId.slice(IMPORTED_THREAD_PREFIX.length).split(":")[0];
  return instanceId || null;
}

const APP_NAMES: Record<string, string> = { codex: "Codex", claudeAgent: "Claude" };

/** The driver an imported thread came from, falling back to the instance's own name. */
function importedDriver(instanceId: string, driver: ProviderDriverKind | null): string {
  if (driver) return driver;
  return instanceId.toLowerCase().includes("claude") ? "claudeAgent" : "codex";
}

/**
 * Marks a thread brought in from the Codex or Claude app with that app's logo, on a chip so it
 * reads apart from the provider icon every thread carries.
 */
export function ImportedThreadBadge({
  threadId,
  driver,
  className,
}: {
  readonly threadId: string;
  /** The provider the thread runs on, when the caller already knows it. */
  readonly driver: ProviderDriverKind | null;
  readonly className?: string;
}) {
  const instanceId = importedThreadInstanceId(threadId);
  if (instanceId === null) return null;
  const kind = importedDriver(instanceId, driver);
  const Icon = PROVIDER_ICON_BY_PROVIDER[kind as ProviderDriverKind];
  if (!Icon) return null;
  const label = `Imported from the ${APP_NAMES[kind] ?? kind} app`;
  return (
    <Tooltip>
      {/* A span, as the sidebar row it sits in is itself a button. */}
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={label}
            className={cn(
              "inline-flex size-4 shrink-0 items-center justify-center rounded-sm bg-muted text-muted-foreground",
              className,
            )}
          />
        }
      >
        <Icon aria-hidden className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** The badge for a thread shown outside the sidebar, resolving its provider from the server. */
export function ImportedThreadBadgeFor({
  environmentId,
  threadId,
  className,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly className?: string;
}) {
  const configs = useServerConfigs();
  const instanceId = importedThreadInstanceId(threadId);
  if (instanceId === null) return null;
  const driver =
    configs.get(environmentId)?.providers.find((provider) => provider.instanceId === instanceId)
      ?.driver ?? null;
  return (
    <ImportedThreadBadge
      threadId={threadId}
      driver={driver}
      {...(className ? { className } : {})}
    />
  );
}
