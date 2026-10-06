import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type SlackState,
  type WorkGitHubPullRequest,
  type WorkRecapInput,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as WorkThreads from "./WorkThreads.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SlackService from "../slack/SlackService.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as WorkRecap from "./WorkRecap.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-28T12:00:00Z");
const merged = (number: number, title: string): WorkGitHubPullRequest => ({
  url: `https://github.com/acme/app/pull/${number}`,
  repository: "acme/app",
  number,
  title,
  isDraft: false,
  updatedAt: "2026-09-27T12:00:00.000Z",
  mergedAt: "2026-09-27T12:00:00.000Z",
});
const INPUT: WorkRecapInput = {
  mode: "weekly",
  since: NOW - 7 * DAY,
  until: NOW,
  period: "this week",
  date: "2026-09-28",
  dayStart: "2026-09-28T00:00:00.000Z",
  dayEnd: "2026-09-29T00:00:00.000Z",
  write: true,
};

/** Answers the assign prompt from its item lines and the summary prompt with fixed text. */
function fakeModel(
  options: {
    readonly assign?: (prompt: string) => unknown;
    readonly plan?: ReadonlyArray<unknown>;
    readonly summary?: string;
  } = {},
) {
  const prompts: string[] = [];
  const generateStructured = ((input: { readonly prompt: string }) => {
    prompts.push(input.prompt);
    if (input.prompt.includes("Return a JSON object with key: features.")) {
      return Effect.succeed({ features: options.plan ?? [] });
    }
    if (!input.prompt.includes("Return a JSON object with key: groups.")) {
      return Effect.succeed({
        summary: options.summary ?? "I shipped refunds.",
        waitingTitles: [],
      });
    }
    if (options.assign) return Effect.succeed(options.assign(input.prompt));
    const items = [...input.prompt.matchAll(/^- (i\d+): /gm)].map((match) => match[1]!);
    const existing = /^- (f\d+) \[/m.exec(input.prompt)?.[1];
    return Effect.succeed({
      groups: [
        {
          feature: existing ?? "",
          title: "Refunds",
          description: "Refunds ship.",
          area: "Payments",
          minor: false,
          items,
        },
      ],
    });
  }) as unknown as TextGeneration.TextGeneration["Service"]["generateStructured"];
  return { prompts, generateStructured };
}

function dependencies(
  slack: { mergedPullRequests: WorkGitHubPullRequest[] },
  model: ReturnType<typeof fakeModel>,
) {
  const state: SlackState = {
    connection: { status: "disconnected" },
    sync: { channelCount: 0, availableChannelCount: 0, syncedChannelCount: 0 },
    includedChannelIds: [],
    devin: { status: "disconnected" },
    conversations: [],
    mentions: [],
    events: { status: "off" },
    threads: [],
    dismissed: [],
    conversationOwners: [],
    conversationWaits: [],
    replyDrafts: [],
    reviewRequests: [],
    authoredPullRequests: [],
    get mergedPullRequests() {
      return slack.mergedPullRequests;
    },
  };
  return Layer.mergeAll(
    Layer.mock(WorkThreads.WorkThreads)({
      getShellSnapshot: () =>
        Effect.succeed({
          schemaVersion: 2,
          snapshotSequence: 0,
          archivedThreads: [],
          projects: [],
          threads: [],
          updatedAt: "2026-09-28T12:00:00.000Z",
        }),
      listThreadIdsWithChanges: () => Effect.succeed([]),
    }),
    Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
    }),
    Layer.mock(SlackService.SlackService)({ current: Effect.sync(() => state) }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("env")),
    }),
    Layer.mock(TextGeneration.TextGeneration)({ generateStructured: model.generateStructured }),
    ServerConfig.layerTest(process.cwd(), { prefix: "t3code-work-recap-test-" }),
  ).pipe(Layer.provideMerge(NodeServices.layer));
}

it.layer(NodeServices.layer)("work recap", (it) => {
  it.effect("groups new work once and only sends later work to the model", () =>
    Effect.gen(function* () {
      const slack = { mergedPullRequests: [merged(1, "Ship refunds"), merged(2, "Refund emails")] };
      const model = fakeModel();
      yield* Effect.gen(function* () {
        const recap = yield* WorkRecap.make;
        const first = yield* recap.recap(INPUT);
        expect(first.features).toMatchObject([{ id: "f1", title: "Refunds", area: "Payments" }]);
        expect(first.features[0]!.items).toHaveLength(2);
        expect(first).toMatchObject({ unassigned: [], stale: false });
        expect(first.summary?.text).toBe("I shipped refunds.");
        expect(model.prompts).toHaveLength(2);

        // Nothing new: the saved grouping and summary are reused without the model.
        yield* recap.recap(INPUT);
        expect(model.prompts).toHaveLength(2);

        slack.mergedPullRequests = [...slack.mergedPullRequests, merged(3, "Refund receipts")];
        const read = yield* recap.recap({ ...INPUT, write: false });
        expect(read).toMatchObject({ stale: true });
        expect(read.unassigned).toHaveLength(1);
        const after = yield* recap.recap(INPUT);
        expect(after.features[0]!.items).toHaveLength(3);
        const assignPrompt = model.prompts.find(
          (prompt, index) => index >= 2 && prompt.includes("key: groups."),
        )!;
        expect(assignPrompt).toContain("- f1 [Payments] Refunds (2 items)");
        expect(assignPrompt).toContain("- i0: Refund receipts");
        expect(assignPrompt).not.toContain("- i1:");

        // A restart reads the saved grouping back instead of grouping again.
        const restarted = yield* WorkRecap.make;
        const promptsBefore = model.prompts.length;
        const again = yield* restarted.recap(INPUT);
        expect(again.features[0]!.items).toHaveLength(3);
        expect(model.prompts).toHaveLength(promptsBefore);
      }).pipe(Effect.provide(dependencies(slack, model)));
    }),
  );

  it.effect("keeps the summary's citations of real features and drops made-up ones", () =>
    Effect.gen(function* () {
      const slack = { mergedPullRequests: [merged(1, "Ship refunds")] };
      const model = fakeModel({ summary: "I shipped refunds [F1] and payroll [F7]." });
      yield* Effect.gen(function* () {
        const view = yield* (yield* WorkRecap.make).recap(INPUT);
        expect(view.summary).toMatchObject({
          text: "I shipped refunds and payroll.",
          citations: [{ at: "I shipped refunds".length, kind: "feature", id: "f1" }],
        });
        // A restart reads the cached summary with its citations.
        const again = yield* (yield* WorkRecap.make).recap({ ...INPUT, write: false });
        expect(again.summary).toEqual(view.summary);
      }).pipe(Effect.provide(dependencies(slack, model)));
    }),
  );

  it.effect("files work the model skipped or misplaced under Other work, and regroups", () =>
    Effect.gen(function* () {
      const slack = { mergedPullRequests: [merged(1, "Ship refunds"), merged(2, "Fix login")] };
      // f999 is no feature and the new group has no title: nothing is placed.
      let answer: unknown = {
        groups: [
          { feature: "f999", title: "", description: "", area: "", minor: false, items: ["i0"] },
        ],
      };
      const model = fakeModel({ assign: () => answer });
      yield* Effect.gen(function* () {
        const recap = yield* WorkRecap.make;
        const view = yield* recap.recap(INPUT);
        // One full pass and one pass for the skipped items, then "Other work".
        expect(model.prompts.filter((prompt) => prompt.includes("key: groups."))).toHaveLength(2);
        expect(view.features).toMatchObject([{ id: "other", title: "Other work" }]);
        expect(view.features[0]!.items).toHaveLength(2);
        expect(view).toMatchObject({ unassigned: [], stale: false });
        // Filed once: opening again does not send the skipped work back to the model.
        const prompts = model.prompts.length;
        yield* recap.recap(INPUT);
        expect(model.prompts).toHaveLength(prompts);

        answer = {
          groups: [
            {
              feature: "",
              title: "Refunds",
              description: "",
              area: "Payments",
              minor: false,
              items: ["i0"],
            },
            {
              feature: "",
              title: "Login",
              description: "",
              area: "Auth",
              minor: false,
              items: ["i1"],
            },
          ],
        };
        const regrouped = yield* recap.recap({ ...INPUT, regroup: true });
        expect(regrouped.features.map((feature) => feature.title).toSorted()).toEqual([
          "Login",
          "Refunds",
        ]);
        expect(regrouped.unassigned).toEqual([]);
      }).pipe(Effect.provide(dependencies(slack, model)));
    }),
  );

  it.effect("plans features for a large batch, then sorts items into them", () =>
    Effect.gen(function* () {
      const slack = {
        mergedPullRequests: Array.from({ length: 12 }, (_, index) =>
          merged(index + 1, index < 10 ? `Hold replies ${index}` : `Fix login ${index}`),
        ),
      };
      const feature = (id: string, title: string, area: string, items: string[]) => ({
        feature: id,
        title,
        description: "",
        area,
        minor: false,
        items,
      });
      const model = fakeModel({
        plan: [
          { ref: "n1", title: "Holds", description: "", area: "Support", minor: false },
          { ref: "n2", title: "Login", description: "", area: "Auth", minor: false },
          { ref: "n3", title: "Unused", description: "", area: "Support", minor: false },
        ],
        assign: (prompt) => {
          // After a plan the model only sorts into the listed features.
          expect(prompt).toContain("every item fits one of them");
          expect(prompt).toContain("- f1 [Support] Holds");
          return {
            groups: [
              feature(
                "f1",
                "Holds",
                "Support",
                Array.from({ length: 10 }, (_, i) => `i${i}`),
              ),
              feature("f2", "Login", "Auth", ["i10", "i11"]),
            ],
          };
        },
      });
      yield* Effect.gen(function* () {
        const recap = yield* WorkRecap.make;
        const view = yield* recap.recap(INPUT);
        expect(view.features.map((entry) => [entry.id, entry.title, entry.items.length])).toEqual([
          ["f1", "Holds", 10],
          ["f2", "Login", 2],
        ]);
        expect(view.unassigned).toEqual([]);
      }).pipe(Effect.provide(dependencies(slack, model)));
    }),
  );
});
