import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "vitest";
import {
  createSandbox,
  destroySandbox,
  writeFixtureAgentSignals,
  writeFixtureUsageState,
} from "../e2e/harness/sandbox";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { withSqlRead } from "../src/main/junto/state/sql-read";

describe("E2E SQLite fixture seeding", () => {
  it("lands the usage-state and agent-signal seeds in the product database", async () => {
    const sandbox = await createSandbox();
    try {
      await writeFixtureUsageState(sandbox, { snapshots: [], lastLiveAt: "2026-09-26T08:00:00.000Z" });
      await writeFixtureAgentSignals(sandbox, [
        {
          signalId: "sig-seed",
          canvasName: "fixture",
          nodeId: "actor",
          kind: "blocked",
          text: "needs a key",
          createdAt: 1_000,
          state: "open",
        },
      ]);

      const runtime = ManagedRuntime.make(
        makeStateEngineLive(join(sandbox.homeDir, ".junto", "state", "junto.db")),
      );
      try {
        const rows = await runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* withSqlRead(sql, Effect.gen(function* () {
              return {
                usage: (yield* sql<{ readonly snapshots_json: string; readonly last_live_at: string }>`
                  SELECT snapshots_json, last_live_at FROM usage_state WHERE singleton = 1
                `)[0],
                signal: (yield* sql<{ readonly node_id: string; readonly state: string }>`
                  SELECT node_id, state FROM agent_signals WHERE signal_id = 'sig-seed'
                `)[0],
              };
            }));
          }),
        );
        expect(rows.usage).toEqual({ snapshots_json: "[]", last_live_at: "2026-09-26T08:00:00.000Z" });
        expect(rows.signal).toEqual({ node_id: "actor", state: "open" });
      } finally {
        await runtime.dispose();
      }
    } finally {
      await destroySandbox(sandbox);
    }
  });
});
