import {
  CommandId,
  MessageId,
  ProjectId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  parseSlackThreadUrl,
  type OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";

export function presentWorkThread(thread: OrchestrationV2ThreadShell) {
  const state =
    thread.status === "failed"
      ? ("error" as const)
      : ["preparing", "queued", "running", "starting"].includes(thread.status)
        ? ("running" as const)
        : ("completed" as const);
  return {
    ...thread,
    pullRequests: thread.pullRequests ?? [],
    createdAt: DateTime.formatIso(thread.createdAt),
    updatedAt: DateTime.formatIso(thread.updatedAt),
    archivedAt: thread.archivedAt === null ? null : DateTime.formatIso(thread.archivedAt),
    settledAt: thread.settledAt === null ? null : DateTime.formatIso(thread.settledAt),
    snoozedUntil: thread.snoozedUntil == null ? null : DateTime.formatIso(thread.snoozedUntil),
    snoozedAt: thread.snoozedAt == null ? null : DateTime.formatIso(thread.snoozedAt),
    hasPendingApprovals:
      thread.pendingRuntimeRequest != null && thread.pendingRuntimeRequest.kind !== "user_input",
    hasPendingUserInput: thread.pendingRuntimeRequest?.kind === "user_input",
    latestTurn: thread.latestRunId == null ? null : { state },
    backgroundLiveness: thread.pendingBackgroundTasks?.some(
      (task) => task.kind === "subagent" || task.kind === "background_task",
    )
      ? ("working" as const)
      : thread.pendingBackgroundTasks?.some((task) => task.kind === "monitor")
        ? ("monitoring" as const)
        : null,
    session: {
      status:
        state === "error"
          ? ("error" as const)
          : state === "running"
            ? ("running" as const)
            : ("ready" as const),
      updatedAt: DateTime.formatIso(thread.updatedAt),
    },
  };
}
export type WorkThreadShell = ReturnType<typeof presentWorkThread>;

export class WorkThreadError extends Schema.TaggedError<WorkThreadError>()("WorkThreadError", {
  message: Schema.String,
}) {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const startThread = Effect.fn("WorkThreads.startThread")(function* (input: {
    readonly caller: WorkThreadShell;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly prompt: string;
    readonly slackPermalink?: string;
  }) {
    const project = yield* projects
      .getShell(input.projectId)
      .pipe(Effect.mapError(() => new WorkThreadError({ message: "Could not read the project." })));
    if (Option.isNone(project))
      return yield* new WorkThreadError({ message: `Project ${input.projectId} was not found.` });
    const link = input.slackPermalink ? parseSlackThreadUrl(input.slackPermalink) : null;
    if (input.slackPermalink && !link)
      return yield* new WorkThreadError({ message: "Pass a Slack message or thread link." });
    const threadId = ThreadId.make(yield* crypto.randomUUIDv4);
    yield* threads
      .dispatch({
        type: "thread.create",
        createdBy: "agent",
        creationSource: "mcp",
        commandId: CommandId.make(`mcp:work:thread-create:${threadId}`),
        threadId,
        projectId: project.value.id,
        title: input.title,
        modelSelection: input.caller.modelSelection,
        runtimeMode: input.caller.runtimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        ...(link ? { linkedSlackThreads: [link.url] } : {}),
      })
      .pipe(
        Effect.mapError(() => new WorkThreadError({ message: "Could not create the thread." })),
      );
    yield* threads
      .sendToThread({
        mode: "auto",
        createdBy: "agent",
        creationSource: "mcp",
        projectId: project.value.id,
        commandId: CommandId.make(`mcp:work:turn-start:${threadId}`),
        threadId,
        messageId: MessageId.make(yield* crypto.randomUUIDv4),
        text: input.prompt,
        attachments: [],
      })
      .pipe(
        Effect.mapError(
          () => new WorkThreadError({ message: "Created the thread but could not start it." }),
        ),
      );
    return { threadId };
  });
  const messageThread = Effect.fn("WorkThreads.messageThread")(function* (input: {
    readonly callerId: ThreadId;
    readonly threadId: ThreadId;
    readonly text: string;
  }) {
    if (input.callerId === input.threadId)
      return yield* new WorkThreadError({ message: "That is this thread. Answer here instead." });
    const target = yield* threads
      .getThreadShell(input.threadId)
      .pipe(Effect.mapError(() => new WorkThreadError({ message: "Could not read the thread." })));
    if (target === null)
      return yield* new WorkThreadError({ message: `Thread ${input.threadId} was not found.` });
    yield* threads
      .sendToThread({
        mode: "auto",
        createdBy: "agent",
        creationSource: "mcp",
        projectId: target.projectId,
        commandId: CommandId.make(`mcp:work:message:${yield* crypto.randomUUIDv4}`),
        threadId: target.id,
        messageId: MessageId.make(yield* crypto.randomUUIDv4),
        text: input.text,
        attachments: [],
      })
      .pipe(
        Effect.mapError(
          () =>
            new WorkThreadError({
              message:
                "The thread did not take the message. It may be busy; try again when it is idle.",
            }),
        ),
      );
    return { sent: true };
  });
  return {
    startThread,
    messageThread,
    getShellSnapshot: () =>
      Effect.all({ shell: threads.getShellSnapshot(), projects: projects.listShells() }).pipe(
        Effect.map(({ shell, projects }) => ({
          ...shell,
          projects,
          threads: [...shell.threads, ...shell.archivedThreads].map(presentWorkThread),
        })),
      ),
    getThreadShellById: (id: ThreadId) =>
      threads
        .getThreadShell(id)
        .pipe(
          Effect.map((thread) =>
            thread === null ? Option.none() : Option.some(presentWorkThread(thread)),
          ),
        ),
    getProjectShellById: projects.getShell,
    getThreadDetailById: (id: ThreadId) =>
      threads.getThreadProjection(id).pipe(
        Effect.flatMap((projection) =>
          threads.getThreadShell(id).pipe(
            Effect.map((shell) =>
              shell === null
                ? Option.none()
                : Option.some({
                    ...presentWorkThread(shell),
                    messages: projection.messages.map((message) => ({
                      ...message,
                      createdAt: DateTime.formatIso(message.createdAt),
                    })),
                  }),
            ),
          ),
        ),
      ),
    listThreadIdsWithChanges: () =>
      sql<{
        readonly thread_id: string;
      }>`SELECT DISTINCT thread_id FROM orchestration_v2_projection_turn_items WHERE type = 'file_change'`.pipe(
        Effect.map((rows) => rows.map((row) => ThreadId.make(row.thread_id))),
      ),
  };
});
export class WorkThreads extends Context.Service<WorkThreads, Effect.Success<typeof make>>()(
  "t3/work/WorkThreads",
) {}
export const layer = Layer.effect(WorkThreads, make);
