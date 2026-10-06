import { CommandId, EventId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as Effect from "effect/Effect";

import * as HtmlRender from "../../../htmlRender/HtmlRender.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  HtmlPreviewToolkit,
  HtmlRenderToolkit,
  HtmlToolFailedError,
  type HtmlToolkit,
} from "./tools.ts";

// Render errors carry actionable messages assembled by the server.
const toFailure = (error: { readonly message: string }) =>
  new HtmlToolFailedError({ message: error.message });

const handlers = {
  html_preview: (input) =>
    Effect.gen(function* () {
      // The headless browser runs on the host and can open local files, so
      // only agents T3 launched, which already work on this machine, get it.
      yield* McpInvocationContext.requireMcpCapability("html");
      const htmlRender = yield* HtmlRender.HtmlRender;
      const { png, ...preview } = yield* htmlRender.preview(input).pipe(Effect.mapError(toFailure));
      return {
        ...preview,
        screenshot: {
          mimeType: "image/png" as const,
          data: png,
          width: preview.width,
          height: preview.capturedHeight,
        },
      };
    }),
  html_render: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("html");
      const engine = yield* OrchestrationEngine.OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const thread = yield* snapshots
        .getThreadShellById(scope.threadId)
        .pipe(
          Effect.mapError(
            () =>
              new HtmlToolFailedError({ message: "Could not read the calling thread. Try again." }),
          ),
        );
      if (Option.isNone(thread))
        return yield* new HtmlToolFailedError({ message: "The calling thread no longer exists." });
      const htmlRender = yield* HtmlRender.HtmlRender;
      const reference = yield* htmlRender
        .publish({ threadId: scope.threadId, ...input })
        .pipe(Effect.mapError(toFailure));
      const id = yield* Crypto.Crypto.pipe(
        Effect.flatMap((crypto) => crypto.randomUUIDv4),
        Effect.orDie,
      );
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      // Persist the page as an activity so every provider and connected client
      // sees it, independently of how the provider encodes MCP tool output.
      yield* engine
        .dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`mcp:html:${id}`),
          threadId: scope.threadId,
          createdAt,
          activity: {
            id: EventId.make(`mcp:html:${id}`),
            kind: "html.rendered",
            tone: "info",
            summary: reference.title,
            turnId: thread.value.session?.activeTurnId ?? null,
            createdAt,
            payload: { htmlRender: reference },
          },
        })
        .pipe(
          Effect.mapError(
            () =>
              new HtmlToolFailedError({
                message: "Could not publish the page to this thread. Try again.",
              }),
          ),
        );
      return {
        htmlRender: reference,
        message:
          "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say.",
      };
    }),
} satisfies Parameters<typeof HtmlToolkit.toLayer>[0];

export const HtmlPreviewToolkitHandlersLive = HtmlPreviewToolkit.toLayer({
  html_preview: handlers.html_preview,
});

export const HtmlRenderToolkitHandlersLive = HtmlRenderToolkit.toLayer({
  html_render: handlers.html_render,
});
