import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { includedWorkProjects, workRootsForEnvironment } from "./workScope";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const project = (id: string, title: string, workspaceRoot: string, environmentId = local) => ({
  id: ProjectId.make(id),
  title,
  workspaceRoot,
  environmentId,
});
const projects = [
  project("root", "tuyoinc", "/Users/jaime/Documents/tuyoinc"),
  project("support", "support-dashboard", "/Users/jaime/Documents/tuyoinc/support-dashboard"),
  project("lookalike", "unrelated", "/Users/jaime/Documents/tuyoinc-other"),
  project("personal", "personal", "/Users/jaime/Desktop/personal"),
  project("remote", "remote", "/Users/jaime/Documents/tuyoinc/mobile", remote),
];

describe("Work folder scope", () => {
  it("starts with the Tuyo parent and includes its descendants in that environment", () => {
    const configs = new Map([[local, { settings: {} }]]);
    expect(
      workRootsForEnvironment(projects, local, configs.get(local)).map((item) => item.id),
    ).toEqual([ProjectId.make("root")]);
    expect(includedWorkProjects(projects, configs).map((item) => item.id)).toEqual([
      ProjectId.make("root"),
      ProjectId.make("support"),
    ]);
  });

  it("honors explicit selection, including an empty scope", () => {
    const configs = new Map([
      [local, { settings: { workProjectRootIds: [ProjectId.make("support")] } }],
    ]);
    expect(includedWorkProjects(projects, configs).map((item) => item.id)).toEqual([
      ProjectId.make("support"),
    ]);
    configs.set(local, { settings: { workProjectRootIds: [] } });
    expect(includedWorkProjects(projects, configs)).toEqual([]);
  });
});
