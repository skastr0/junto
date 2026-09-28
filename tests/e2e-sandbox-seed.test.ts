import { join } from "node:path";
import { ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";
import {
  createSandbox,
  destroySandbox,
  writeFixtureAgentSignals,
  writeFixtureUsageState,
} from "../e2e/harness/sandbox";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/junto/state/engine";

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
        const state = await runtime.runPromise(StateEngine);
        const rows = await runtime.runPromise(
          state.read("test.e2e-seed-witness", (reader) => ({
            usage: reader.get<{ readonly snapshots_json: string; readonly last_live_at: string }>(
              "SELECT snapshots_json, last_live_at FROM usage_state WHERE singleton = 1",
            ),
            signal: reader.get<{ readonly node_id: string; readonly state: string }>(
              "SELECT node_id, state FROM agent_signals WHERE signal_id = 'sig-seed'",
            ),
          })),
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
