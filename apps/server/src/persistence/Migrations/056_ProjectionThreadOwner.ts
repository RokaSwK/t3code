import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // NULL is the creator (the person running this environment); a JSON ThreadOwner otherwise.
  yield* sql`ALTER TABLE projection_threads ADD COLUMN owner_json TEXT`;
});
