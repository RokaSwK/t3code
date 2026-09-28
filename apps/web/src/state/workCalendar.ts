import { createWorkCalendarEnvironmentAtoms } from "@t3tools/client-runtime/state/work-calendar";
import { connectionAtomRuntime } from "../connection/runtime";
export const workCalendar = createWorkCalendarEnvironmentAtoms(connectionAtomRuntime);
