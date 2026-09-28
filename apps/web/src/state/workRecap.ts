import { createWorkRecapEnvironmentAtoms } from "@t3tools/client-runtime/state/work-recap";
import { connectionAtomRuntime } from "../connection/runtime";
export const workRecap = createWorkRecapEnvironmentAtoms(connectionAtomRuntime);
