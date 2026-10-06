import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "./Migrations.ts";
import SlackLinks from "./Migrations/055_ProjectionThreadSlackLinks.ts";
import Owner from "./Migrations/056_ProjectionThreadOwner.ts";
import MergeWait from "./Migrations/057_ProjectionThreadsMergeWait.ts";

it.effect(
  "upgrades released Personal migrations without skipping upstream's V2 schema or losing columns",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* Migrator.make({})({
        loader: Migrator.fromRecord({
          "55_ProjectionThreadSlackLinks": SlackLinks,
          "56_ProjectionThreadOwner": Owner,
          "57_ProjectionThreadsMergeWait": MergeWait,
        }),
      });
      yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('p','Project','/tmp/p','[]','2026-09-29','2026-09-29')`;
      yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,runtime_mode,interaction_mode,created_at,updated_at,linked_slack_threads_json,owner_json,waiting_for_merge_at) VALUES ('t','p','Thread','{"instanceId":"codex","model":"test"}','full-access','default','2026-09-29','2026-09-29','["https://acme.slack.com/archives/C123/p1700000000000000"]','{"userId":"U1","name":"Rick"}','2026-09-29')`;
      const before =
        yield* sql`SELECT linked_slack_threads_json,owner_json,waiting_for_merge_at FROM projection_threads`;
      yield* runMigrations();
      assert.deepStrictEqual(
        yield* sql`SELECT linked_slack_threads_json,owner_json,waiting_for_merge_at FROM projection_threads`,
        before,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id IN (55,56,57,59) ORDER BY migration_id`,
        [
          { name: "OrchestrationV2" },
          { name: "RemoveRedundantProjectionIndexes" },
          { name: "ScheduledTaskWebhooks" },
          { name: "PersonalThreadMetadata" },
        ],
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.equal(
        (yield* sql`SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_projection_threads'`)
          .length,
        1,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
