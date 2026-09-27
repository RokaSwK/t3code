import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { workRootsForEnvironment } from "./workScope";

function EnvironmentFolders({
  environmentId,
  config,
  projects,
  search,
}: {
  readonly environmentId: EnvironmentId;
  readonly config: ServerConfig;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly search: string;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const roots = workRootsForEnvironment(projects, environmentId, config);
  const selected = new Set(roots.map((project) => project.id));
  const candidates = projects
    .filter(
      (project) =>
        project.environmentId === environmentId &&
        `${project.title} ${project.workspaceRoot}`.toLocaleLowerCase().includes(search),
    )
    .toSorted((left, right) => left.workspaceRoot.localeCompare(right.workspaceRoot));
  if (candidates.length === 0) return null;
  return (
    <section className="flex flex-col gap-1">
      <h3 className="px-2 pt-3 text-xs font-medium text-muted-foreground">
        {config.environment.label}
      </h3>
      {candidates.map((project) => (
        <div key={project.id} className="flex min-w-0 items-center gap-3 rounded-md px-2 py-1.5">
          <Checkbox
            id={`work-${environmentId}-${project.id}`}
            checked={selected.has(project.id)}
            onCheckedChange={(checked) => {
              const next = new Set(selected);
              if (checked === true) next.add(project.id);
              else next.delete(project.id);
              updateSettings({ workProjectRootIds: [...next] });
            }}
          />
          <label
            htmlFor={`work-${environmentId}-${project.id}`}
            className="flex min-w-0 flex-1 cursor-pointer flex-col text-sm"
          >
            <span className="truncate">{project.title}</span>
            <span className="truncate text-xs text-muted-foreground">{project.workspaceRoot}</span>
          </label>
        </div>
      ))}
    </section>
  );
}

export function WorkScopeDialog({
  open,
  onOpenChange,
  projects,
  configs,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly configs: ReadonlyMap<EnvironmentId, ServerConfig>;
}) {
  const [search, setSearch] = useState("");
  const environments = [...new Set(projects.map((project) => project.environmentId))];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Work folders</DialogTitle>
          <DialogDescription>
            Include Tuyo folders here. Choosing a parent also includes its projects and worktrees.
          </DialogDescription>
          <Input
            type="search"
            aria-label="Search folders"
            placeholder="Search folders"
            value={search}
            onChange={(event) => setSearch(event.target.value.toLocaleLowerCase())}
          />
        </DialogHeader>
        <DialogPanel>
          <div className="flex max-h-96 flex-col overflow-y-auto px-6 pb-6">
            {environments.map((environmentId) => {
              const config = configs.get(environmentId);
              return config ? (
                <EnvironmentFolders
                  key={environmentId}
                  environmentId={environmentId}
                  config={config}
                  projects={projects}
                  search={search}
                />
              ) : null;
            })}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
