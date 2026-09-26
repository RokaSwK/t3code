import { createSlackEnvironmentAtoms } from "@t3tools/client-runtime/state/slack";
import type { EnvironmentId, SlackState } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

export const slackEnvironment = createSlackEnvironmentAtoms(connectionAtomRuntime);

export function useSlackState(environmentId: EnvironmentId | null): SlackState | null {
  const query = useEnvironmentQuery(
    environmentId === null ? null : slackEnvironment.state({ environmentId, input: {} }),
  );
  return query.data;
}
