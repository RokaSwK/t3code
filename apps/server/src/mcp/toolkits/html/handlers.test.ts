import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../../config.ts";
import * as HtmlRender from "../../../htmlRender/HtmlRender.ts";
import * as PreviewBrowser from "../../../htmlRender/PreviewBrowser.ts";
import { OrchestrationEngineLive } from "../../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { HtmlRenderToolkitHandlersLive } from "./handlers.ts";
import { HtmlRenderToolkit } from "./tools.ts";

const layer = HtmlRenderToolkitHandlersLive.pipe(
  Layer.provideMerge(HtmlRender.layer),
  Layer.provide(
    Layer.succeed(PreviewBrowser.PreviewBrowser, {
      installed: Effect.succeed(Option.none()),
      executable: Effect.die("This test must not launch a browser."),
    }),
  ),
  Layer.provideMerge(
    OrchestrationEngineLive.pipe(
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provideMerge(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provideMerge(SqlitePersistenceMemory),
    ),
  ),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-html-mcp-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layer)("HTML publication", (it) => {
  it.effect(
    "persists a page for connected clients, checks capability, and deletes its file with the thread",
    () =>
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const snapshots = yield* ProjectionSnapshotQuery;
        const built = yield* HtmlRenderToolkit;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const threadId = ThreadId.make("html-thread");
        const projectId = ProjectId.make("html-project");
        const createdAt = "2026-10-06T00:00:00.000Z";
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("html-project-create"),
          projectId,
          title: "HTML",
          workspaceRoot: "/tmp/html-project",
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("html-thread-create"),
          threadId,
          projectId,
          title: "HTML",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        const scope: McpInvocationContext.McpInvocationScope = {
          environmentId: EnvironmentId.make("local"),
          threadId,
          providerSessionId: "html-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
          capabilities: new Set(["html"]),
          issuedAt: 0,
        };
        const call = (capabilities: McpInvocationContext.McpInvocationScope["capabilities"]) =>
          built
            .handle("html_render", {
              html: "<html><body>Chart</body></html>",
              title: "Chart",
              height: 400,
            })
            .pipe(
              Stream.unwrap,
              Stream.runCollect,
              Effect.provideService(McpInvocationContext.McpInvocationContext, {
                ...scope,
                capabilities,
              }),
            );
        const denied = yield* call(new Set());
        expect(denied[0]?.isFailure).toBe(true);
        expect(
          yield* fs
            .readDirectory(config.attachmentsDir)
            .pipe(Effect.catch(() => Effect.succeed([]))),
        ).toEqual([]);
        const published = yield* call(scope.capabilities);
        expect(published[0]?.isFailure).toBe(false);
        const detail = yield* snapshots.getThreadDetailById(threadId);
        expect(Option.isSome(detail)).toBe(true);
        if (Option.isNone(detail)) return;
        const activity = detail.value.activities.find((item) => item.kind === "html.rendered");
        expect(activity?.summary).toBe("Chart");
        const files = yield* fs.readDirectory(config.attachmentsDir);
        expect(files).toHaveLength(1);
        const pagePath = path.join(config.attachmentsDir, files[0]!);
        expect(yield* fs.readFileString(pagePath)).toContain("Chart");
        yield* engine.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("html-thread-delete"),
          threadId,
          createdAt,
        });
        expect(yield* fs.exists(pagePath)).toBe(false);
      }),
  );
});
