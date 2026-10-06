import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Earlier Personal builds recorded these columns under upstream's ids 55–57.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("linked_slack_threads_json")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN linked_slack_threads_json TEXT NOT NULL DEFAULT '[]'`;
  }
  if (!names.has("owner_json")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN owner_json TEXT`;
  }
  if (!names.has("waiting_for_merge_at")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN waiting_for_merge_at TEXT`;
  }
});
