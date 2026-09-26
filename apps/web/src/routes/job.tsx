import { createFileRoute } from "@tanstack/react-router";

import { JobPage } from "../components/job/JobPage";

export const Route = createFileRoute("/job")({ component: JobPage });
