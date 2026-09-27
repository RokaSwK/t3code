import { createFileRoute } from "@tanstack/react-router";

import { WorkSettingsPanel } from "../components/job/WorkSettingsPanel";

export const Route = createFileRoute("/settings/work")({
  component: WorkSettingsPanel,
});
