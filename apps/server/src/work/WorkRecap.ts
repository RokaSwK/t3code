/**
 * WorkRecap - the Work page's daily standup and weekly demo, built on the server.
 *
 * Finished work never changes, so each item is grouped into a feature once and stays there.
 * The feature list is saved beside the database; only work no feature holds yet goes to the
 * text generation model, next to the existing features, which keeps groups and names stable
 * between opens, between the daily and weekly views, and across clients. The summary is
 * written from the grouped view and cached until that view changes.
 *
 * @module WorkRecap
 */
import {
  type ModelSelection,
  WorkRecapError,
  type WorkRecapFeature,
  type WorkRecapInput,
  type WorkRecapItem,
  type WorkRecapView,
} from "@t3tools/contracts";
import {
  buildWorkGroups,
  includedWorkProjects,
  workItemTitle,
  type WorkGroup,
  type WorkThread,
} from "@t3tools/shared/work";
import {
  buildWorkAccomplishments,
  buildWorkPlan,
  recapWaitingGroups,
} from "@t3tools/shared/workRecap";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SlackService from "../slack/SlackService.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  buildAssignPrompt,
  buildPlanPrompt,
  buildSummaryPrompt,
  type RecapStoreFeature,
} from "./WorkRecapPrompts.ts";

const StoreFeature = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  area: Schema.String,
  minor: Schema.Boolean,
});
const Store = Schema.Struct({
  nextFeature: Schema.Number,
  features: Schema.Array(StoreFeature),
  /** Finished work to feature; `keys` are every key the item is known by. */
  assignments: Schema.Array(
    Schema.Struct({
      keys: Schema.Array(Schema.String),
      featureId: Schema.String,
      title: Schema.String,
      at: Schema.Number,
    }),
  ),
  waitingTitles: Schema.Array(Schema.Struct({ groupId: Schema.String, title: Schema.String })),
  summaries: Schema.Array(
    Schema.Struct({ key: Schema.String, text: Schema.String, model: Schema.String }),
  ),
});
type Store = typeof Store.Type;
const decodeStore = Schema.decodeUnknownEffect(Schema.fromJsonString(Store));
const encodeStore = Schema.encodeEffect(Schema.fromJsonString(Store));

const EMPTY_STORE: Store = {
  nextFeature: 1,
  features: [],
  assignments: [],
  waitingTitles: [],
  summaries: [],
};
const STORE_FILE = "work-recap.json";
const isWorkRecapError = Schema.is(WorkRecapError);
const OTHER_FEATURE = {
  id: "other",
  title: "Other work",
  description: "",
  area: "Other",
  minor: false,
};
/** Assignments older than this are forgotten; recaps look back a week at most. */
const ASSIGNMENT_TTL_MS = 60 * 86_400_000;
/** A whole week in one batch, so the model can group new items with each other. */
const ASSIGN_BATCH = 120;
const KEPT_SUMMARIES = 8;
const KEPT_WAITING_TITLES = 300;

/** The recap facts the model and the view are built from, gathered from server state. */
interface Gathered {
  readonly items: ReadonlyArray<WorkRecapItem>;
  readonly waiting: ReadonlyArray<WorkGroup>;
  readonly planned: ReadonlyArray<string>;
}

export class WorkRecap extends Context.Service<
  WorkRecap,
  {
    readonly recap: (input: WorkRecapInput) => Effect.Effect<WorkRecapView, WorkRecapError>;
  }
>()("t3/work/WorkRecap") {}

/** FNV-1a; cache keys only need to tell recaps apart, not resist anyone. */
function hashKey(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** How many items each feature holds and a few of their titles, for prompts. */
function featureUsage(assignments: Store["assignments"]) {
  const usage = new Map<string, { count: number; titles: string[]; at: number }>();
  for (const assignment of assignments) {
    const entry = usage.get(assignment.featureId) ?? { count: 0, titles: [], at: 0 };
    entry.count += 1;
    if (entry.titles.length < 3) entry.titles.push(assignment.title);
    entry.at = Math.max(entry.at, assignment.at);
    usage.set(assignment.featureId, entry);
  }
  return usage;
}

/** From this many new items, features are planned before items are sorted into them. */
const PLAN_THRESHOLD = 12;

function featureOf(store: Store, keys: ReadonlyArray<string>): string | undefined {
  const known = new Set(store.features.map((feature) => feature.id));
  return store.assignments.find(
    (assignment) =>
      known.has(assignment.featureId) && assignment.keys.some((key) => keys.includes(key)),
  )?.featureId;
}

/** The view a client draws: items, their features, and whatever still needs writing. */
export function buildRecapView(
  store: Store,
  gathered: Gathered,
  summaryKey: string,
): WorkRecapView {
  const byFeature = new Map<string, string[]>();
  const unassigned: string[] = [];
  for (const item of gathered.items) {
    const featureId = featureOf(store, item.keys);
    if (featureId) byFeature.set(featureId, [...(byFeature.get(featureId) ?? []), item.keys[0]!]);
    else unassigned.push(item.keys[0]!);
  }
  const features: WorkRecapFeature[] = store.features.flatMap((feature) => {
    const items = byFeature.get(feature.id);
    return items ? [{ ...feature, items }] : [];
  });
  const titles = new Map(store.waitingTitles.map((entry) => [entry.groupId, entry.title]));
  const waitingTitles = gathered.waiting.flatMap((group) => {
    const title = titles.get(group.id);
    return title ? [{ groupId: group.id, title }] : [];
  });
  const summary = store.summaries.find((entry) => entry.key === summaryKey);
  return {
    items: gathered.items,
    features,
    unassigned,
    waitingTitles,
    summary: summary ? { text: summary.text, model: summary.model } : null,
    stale: unassigned.length > 0 || !summary || waitingTitles.length < gathered.waiting.length,
  };
}

/** What the summary depends on; it is rewritten only when this changes. */
export function recapSummaryKey(
  input: Pick<WorkRecapInput, "mode" | "period" | "meetings">,
  store: Store,
  gathered: Gathered,
): string {
  const counts = new Map<string, number>();
  const loose: string[] = [];
  for (const item of gathered.items) {
    const featureId = featureOf(store, item.keys);
    if (featureId) counts.set(featureId, (counts.get(featureId) ?? 0) + 1);
    else loose.push(item.keys[0]!);
  }
  return hashKey(
    JSON.stringify([
      input.mode,
      input.period,
      [...counts].toSorted(),
      loose.toSorted(),
      gathered.waiting.map((group) => group.id).toSorted(),
      gathered.planned,
      input.meetings ?? [],
    ]),
  );
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const slack = yield* SlackService.SlackService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const storePath = path.join(config.stateDir, STORE_FILE);
  // One writer at a time: two clients opening the recap must not group the same work twice.
  const writer = yield* Semaphore.make(1);
  let cached: Store | null = null;

  const fail = (message: string) => () => new WorkRecapError({ message });

  const load = Effect.gen(function* () {
    if (cached) return cached;
    const text = yield* fileSystem.readFileString(storePath).pipe(Effect.orElseSucceed(() => null));
    // An unreadable file only costs grouping the recent work again.
    cached = text
      ? yield* decodeStore(text).pipe(Effect.orElseSucceed(() => EMPTY_STORE))
      : EMPTY_STORE;
    return cached;
  });

  const save = (store: Store, now: number) =>
    Effect.gen(function* () {
      const assignments = store.assignments.filter(
        (assignment) => assignment.at >= now - ASSIGNMENT_TTL_MS,
      );
      const used = new Set(assignments.map((assignment) => assignment.featureId));
      const next: Store = {
        ...store,
        assignments,
        features: store.features.filter((feature) => used.has(feature.id)),
        summaries: store.summaries.slice(-KEPT_SUMMARIES),
        waitingTitles: store.waitingTitles.slice(-KEPT_WAITING_TITLES),
      };
      cached = next;
      const contents = yield* encodeStore(next);
      yield* writeFileStringAtomically({ filePath: storePath, contents }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not save the work recap", { cause: String(cause) }),
      ),
    );

  const gather = (input: WorkRecapInput) =>
    Effect.gen(function* () {
      const shell = yield* snapshots.getShellSnapshot();
      const settings = yield* settingsService.getSettings;
      const slackState = yield* slack.current;
      const changed = new Set<string>(yield* snapshots.listThreadIdsWithChanges());
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      // The real id, so thread keys and group ids match the client's and the saved marks.
      const environmentId = yield* environment.getEnvironmentId;
      const threads: WorkThread[] = shell.threads.map((thread) => ({ ...thread, environmentId }));
      const slackConnected = slackState.connection.status === "connected";
      const groups = buildWorkGroups(threads, {
        ...(slackConnected
          ? { conversations: slackState.conversations, channelThreads: slackState.threads }
          : {}),
        dismissed: slackState.dismissed,
        owners: slackState.conversationOwners,
        waits: slackState.conversationWaits,
        github: {
          reviewRequests: slackState.reviewRequests,
          authored: slackState.authoredPullRequests,
          ...(settings.workGitHubOwners ? { owners: settings.workGitHubOwners } : {}),
        },
        now,
      });
      const projects = shell.projects.map((project) => ({
        environmentId,
        id: project.id,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
      }));
      const included = new Set<string>(
        includedWorkProjects(
          projects,
          new Map([
            [
              environmentId,
              {
                settings: settings.workProjectRootIds
                  ? { workProjectRootIds: settings.workProjectRootIds }
                  : {},
              },
            ],
          ]),
        ).map((project) => project.id),
      );
      // The Work page's own scope: your conversations, your PRs, and T3 work in Work folders.
      const recapGroups = groups.filter(
        (group) =>
          group.conversation !== null ||
          group.pullRequest !== null ||
          group.threads.some((thread) => included.has(thread.projectId)),
      );
      const ignored = settings.workIgnoredItems ?? [];
      const projectTitles = new Map<string, string>(
        shell.projects.map((project) => [project.id, project.title]),
      );
      const items = buildWorkAccomplishments({
        groups: recapGroups,
        threads: threads.filter((thread) => included.has(thread.projectId)),
        slack: slackState,
        ignored,
        githubOwners: settings.workGitHubOwners,
        changedThreadIds: changed,
        since: input.since,
        now: input.until - 1,
      }).map(({ project, ...item }): WorkRecapItem => {
        const projectTitle = project ? projectTitles.get(project.projectId) : undefined;
        return projectTitle ? { ...item, projectTitle } : item;
      });
      const planned =
        input.mode === "daily"
          ? buildWorkPlan(
              settings.workDayPlan?.date === input.date ? settings.workDayPlan.items : [],
              recapGroups,
              ignored,
            ).map((item) => item.title)
          : [];
      return {
        items,
        waiting: input.mode === "daily" ? recapWaitingGroups(recapGroups, ignored, now) : [],
        planned,
        now,
        modelSelection: settings.textGenerationModelSelection,
      };
    }).pipe(Effect.mapError(fail("Could not read your work.")));

  /** Runs a prompt in an empty directory: these are pure text tasks, not work in a checkout. */
  const generate = <S extends Schema.Top & { readonly DecodingServices: never }>(
    prompt: string,
    outputSchema: S,
    modelSelection: ModelSelection,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-work-recap-" });
        return yield* textGeneration.generateStructured({
          cwd,
          prompt,
          outputSchema,
          modelSelection,
        });
      }),
    );

  /** Puts work no feature holds into existing features or new ones, in batches. */
  const assign = (
    store: Store,
    items: ReadonlyArray<WorkRecapItem>,
    modelSelection: ModelSelection,
    now: number,
  ) =>
    Effect.gen(function* () {
      const features = [...store.features];
      const assignments = [...store.assignments];
      let nextFeature = store.nextFeature;
      const queue: Array<{
        readonly batch: ReadonlyArray<WorkRecapItem>;
        readonly retry: boolean;
      }> = [];
      for (let start = 0; start < items.length; start += ASSIGN_BATCH)
        queue.push({ batch: items.slice(start, start + ASSIGN_BATCH), retry: false });
      for (let next = queue.shift(); next; next = queue.shift()) {
        const { batch, retry } = next;
        const usage = featureUsage(assignments);
        // "Other work" is where skipped work waits; it is never offered as a feature.
        const existing: RecapStoreFeature[] = features
          .flatMap((feature) => {
            const used = usage.get(feature.id);
            return used && feature.id !== OTHER_FEATURE.id ? [{ ...feature, ...used }] : [];
          })
          .toSorted((a, b) => b.at - a.at)
          .slice(0, 80);
        // A large batch gets its features named first, then only sorted into them.
        const planned: RecapStoreFeature[] = [];
        if (!retry && batch.length >= PLAN_THRESHOLD) {
          const plan = buildPlanPrompt({ existing, items: batch });
          const proposal = yield* generate(plan.prompt, plan.outputSchema, modelSelection);
          for (const feature of proposal.features) {
            const title = feature.title.trim();
            if (!title) continue;
            const id = `f${nextFeature++}`;
            const created = {
              id,
              title,
              description: feature.description.trim(),
              area: feature.area.trim() || "Other",
              minor: feature.minor,
            };
            features.push(created);
            planned.push({ ...created, count: 0, titles: [] });
          }
        }
        const { prompt, outputSchema } = buildAssignPrompt({
          features: [...existing, ...planned],
          items: batch,
          allowNew: planned.length === 0,
        });
        const result = yield* generate(prompt, outputSchema, modelSelection);
        const known = new Set([...existing, ...planned].map((feature) => feature.id));
        // An item the model put in two groups keeps its first.
        const placed = new Set<string>();
        for (const group of result.groups) {
          const members = [...new Set(group.items)].flatMap((id) => {
            const index = Number(id.replace(/^i/, ""));
            const item = Number.isInteger(index) ? batch[index] : undefined;
            return item && !placed.has(item.keys[0]!) ? [item] : [];
          });
          if (members.length === 0) continue;
          let featureId = known.has(group.feature) ? group.feature : undefined;
          // After a plan the model only sorts; an unknown feature leaves the items for the retry.
          if (!featureId && planned.length > 0) continue;
          if (!featureId) {
            const title = group.title.trim();
            if (!title) continue;
            featureId = `f${nextFeature++}`;
            features.push({
              id: featureId,
              title,
              description: group.description.trim(),
              area: group.area.trim() || "Other",
              minor: group.minor,
            });
          }
          for (const item of members) {
            placed.add(item.keys[0]!);
            assignments.push({ keys: item.keys, featureId, title: item.title, at: item.at });
          }
        }
        yield* Effect.logDebug("work recap sorted work", {
          items: batch.length,
          retry,
          planned: planned.length,
          groups: result.groups.length,
          placed: placed.size,
        });
        // A long batch makes the model skip some items; they get one short pass of their own.
        // Anything still skipped goes to "Other work" rather than back to the model on every
        // open; a regroup gives it another chance.
        const skipped = batch.filter((item) => !placed.has(item.keys[0]!));
        if (skipped.length > 0 && !retry) queue.push({ batch: skipped, retry: true });
        else {
          for (const item of skipped) {
            if (!features.some((feature) => feature.id === OTHER_FEATURE.id))
              features.push(OTHER_FEATURE);
            assignments.push({
              keys: item.keys,
              featureId: OTHER_FEATURE.id,
              title: item.title,
              at: item.at,
            });
          }
        }
        yield* save({ ...store, nextFeature, features, assignments }, now);
      }
      return { ...store, nextFeature, features, assignments };
    });

  const recap: WorkRecap["Service"]["recap"] = (input) =>
    Effect.gen(function* () {
      const gathered = yield* gather(input);
      const read = yield* load;
      const view = buildRecapView(read, gathered, recapSummaryKey(input, read, gathered));
      if (!input.write || (!view.stale && !input.regroup)) return view;
      return yield* writer.withPermits(1)(
        Effect.gen(function* () {
          let store = yield* load;
          if (input.regroup) {
            const windowKeys = new Set(gathered.items.flatMap((item) => item.keys));
            store = {
              ...store,
              assignments: store.assignments.filter(
                (assignment) => !assignment.keys.some((key) => windowKeys.has(key)),
              ),
            };
          }
          const loose = gathered.items.filter((item) => !featureOf(store, item.keys));
          if (loose.length > 0)
            store = yield* assign(store, loose, gathered.modelSelection, gathered.now);
          const summaryKey = recapSummaryKey(input, store, gathered);
          const titled = new Set(store.waitingTitles.map((entry) => entry.groupId));
          const untitled = gathered.waiting.filter((group) => !titled.has(group.id));
          const hasSummary = store.summaries.some((entry) => entry.key === summaryKey);
          if (!hasSummary || untitled.length > 0 || input.regroup) {
            const { prompt, outputSchema } = buildSummaryPrompt({
              mode: input.mode,
              period: input.period,
              view: buildRecapView(store, gathered, summaryKey),
              planned: gathered.planned,
              meetings: input.meetings ?? [],
              waiting: gathered.waiting.map((group) => ({
                id: group.id,
                text: workItemTitle(group),
                reason: group.reason,
                needsTitle: !titled.has(group.id),
              })),
            });
            const result = yield* generate(prompt, outputSchema, gathered.modelSelection);
            const waitingTitles = result.waitingTitles.flatMap((entry) => {
              const group = gathered.waiting[Number(entry.item.replace(/^w/, ""))];
              const title = entry.title.trim();
              return group && title && !titled.has(group.id) ? [{ groupId: group.id, title }] : [];
            });
            store = {
              ...store,
              waitingTitles: [...store.waitingTitles, ...waitingTitles],
              summaries: [
                ...store.summaries.filter((entry) => entry.key !== summaryKey),
                {
                  key: summaryKey,
                  text: result.summary.trim(),
                  model: gathered.modelSelection.model,
                },
              ],
            };
            yield* save(store, gathered.now);
          }
          return buildRecapView(store, gathered, summaryKey);
        }),
      );
    }).pipe(
      Effect.mapError((error) =>
        isWorkRecapError(error)
          ? error
          : new WorkRecapError({
              message:
                "detail" in error && typeof error.detail === "string"
                  ? error.detail
                  : "The recap could not be written.",
            }),
      ),
    );

  return WorkRecap.of({ recap });
});

export const layer = Layer.effect(WorkRecap, make);
