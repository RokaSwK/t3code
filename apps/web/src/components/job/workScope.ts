import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId, ServerSettings } from "@t3tools/contracts";

type WorkProject = Pick<EnvironmentProject, "environmentId" | "id" | "title" | "workspaceRoot">;
type WorkConfig = { readonly settings: Pick<ServerSettings, "workProjectRootIds"> };

function normalizedRoot(root: string): string {
  return root.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

/** The personal fork starts with the Tuyo workspace, then uses explicit server settings. */
export function workRootsForEnvironment<Project extends WorkProject>(
  projects: ReadonlyArray<Project>,
  environmentId: EnvironmentId,
  config: WorkConfig | undefined,
): ReadonlyArray<Project> {
  if (!config) return [];
  const local = projects.filter((project) => project.environmentId === environmentId);
  const selected = config.settings.workProjectRootIds;
  if (selected !== undefined) {
    const ids = new Set<ProjectId>(selected);
    return local.filter((project) => ids.has(project.id));
  }
  return local.filter(
    (project) =>
      project.title.toLowerCase() === "tuyoinc" ||
      normalizedRoot(project.workspaceRoot).endsWith("/tuyoinc"),
  );
}

export function includedWorkProjects<Project extends WorkProject>(
  projects: ReadonlyArray<Project>,
  configs: ReadonlyMap<EnvironmentId, WorkConfig>,
): ReadonlyArray<Project> {
  const roots = new Map<EnvironmentId, ReadonlyArray<string>>();
  for (const environmentId of new Set(projects.map((project) => project.environmentId))) {
    roots.set(
      environmentId,
      workRootsForEnvironment(projects, environmentId, configs.get(environmentId)).map((project) =>
        normalizedRoot(project.workspaceRoot),
      ),
    );
  }
  return projects.filter((project) => {
    const path = normalizedRoot(project.workspaceRoot);
    return roots
      .get(project.environmentId)
      ?.some((root) => path === root || path.startsWith(`${root}/`));
  });
}
