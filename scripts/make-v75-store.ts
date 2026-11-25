/**
 * Writes a junto.db with v0.11.14's own code (schema 75): one canvas with one
 * seat and its signals of every state, as that release stored them. Run from
 * the root of a v0.11.14 checkout: bun scripts/make-v75-store.ts <out.db>
 */
import { copyFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
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
const database = new DatabaseSync(path);
database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
const version = database.prepare("PRAGMA user_version").get() as { user_version: number };
const signals = database.prepare("SELECT signal_id, state FROM agent_signals ORDER BY signal_id").all();
const columns = database.prepare("SELECT name FROM pragma_table_info('agent_signals')").all().map((row) => (row as { name: string }).name);
database.close();
await copyFile(path, out);
console.log(JSON.stringify({ out, userVersion: version.user_version, signals, columns }));
