/**
 * Writes a junto.db with v0.11.14's own code (schema 75): one canvas with one
 * seat and its signals of every state, as that release stored them. Run from
 * the root of a v0.11.14 checkout: bun scripts/make-v75-store.ts <out.db>
 *
 * It never opens SQLite itself: the harness writes the store, and that
 * release's scoped state engine checkpoints the WAL into the file, which the
 * close alone does not. The schema version comes from the file's own header,
 * and e2e/scenarios/signal-cli.spec.ts reads the rows back through the app.
 */
import { copyFile, open, stat } from "node:fs/promises";
import { join } from "node:path";
import { plugin } from "bun";

// A vite `?nodeWorker` import has no worker under bun: it resolves to nothing,
// and the state engine then backs up on its own thread, as the machine core
// bundle does (scripts/build-machine.ts).
plugin({
  name: "no-node-worker",
  setup(builder) {
    builder.onLoad({ filter: /\?nodeWorker$/ }, () => ({ contents: "export default undefined;", loader: "js" }));
  },
});
const { createSandbox, writeFixtureAgentSignals, writeFixtureModel } = await import("../e2e/harness/sandbox");
const { modelFixture, modelSeat } = await import("../e2e/harness/model");
const { makeStateEngineLive } = await import("../src/core/state/engine");
const { Effect, ManagedRuntime } = await import("effect");
const { SqlClient } = await import("effect/sql");

const out = process.argv[2];
if (out === undefined) throw new Error("usage: bun scripts/make-v75-store.ts <out.db>");

const CANVAS = "signalold";
const SEAT = "veteran";
const sandbox = await createSandbox();
await writeFixtureModel(sandbox, CANVAS, modelFixture([modelSeat({ id: SEAT, label: "Veteran", x: 60, y: 80 })]));
const base = { canvasName: CANVAS, nodeId: SEAT } as const;
await writeFixtureAgentSignals(sandbox, [
  { ...base, signalId: "01M8S00000000000000000000A", kind: "blocked", text: "Old blocked, still open", createdAt: 1_795_000_000_000, state: "open" },
  { ...base, signalId: "01M8S00000000000000000000B", kind: "escalate", text: "Old escalate, still open", createdAt: 1_795_000_001_000, state: "open" },
  { ...base, signalId: "01M8S00000000000000000000C", kind: "escalate", text: "Old escalate, answered", createdAt: 1_795_000_002_000, state: "answered", response: { text: "use sqlite", at: 1_795_000_005_000 }, closedAt: 1_795_000_005_000 },
  { ...base, signalId: "01M8S00000000000000000000D", kind: "feedback", text: "Old feedback, dismissed", createdAt: 1_795_000_003_000, state: "dismissed", closedAt: 1_795_000_006_000 },
] as never);

const path = join(sandbox.homeDir, ".junto", "state", "junto.db");
const engine = ManagedRuntime.make(makeStateEngineLive(path));
try {
  await engine.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe("PRAGMA wal_checkpoint(TRUNCATE)")));
} finally {
  await engine.dispose();
}
// A WAL with frames left would mean the copy misses rows.
const wal = await stat(`${path}-wal`).catch(() => undefined);
if (wal !== undefined && wal.size > 0) throw new Error(`${path}-wal still holds ${String(wal.size)} bytes: the store was not closed`);
// user_version is the header's 4 big-endian bytes at offset 60 (sqlite.org/fileformat.html).
const header = Buffer.alloc(64);
const file = await open(path, "r");
await file.read(header, 0, 64, 0);
await file.close();
if (header.toString("latin1", 0, 15) !== "SQLite format 3") throw new Error(`${path} is not a SQLite database`);
const userVersion = header.readUInt32BE(60);
if (userVersion !== 75) throw new Error(`${path} is schema ${String(userVersion)}, not 75: run this from a v0.11.14 checkout`);
await copyFile(path, out);
console.log(JSON.stringify({ out, userVersion }));
