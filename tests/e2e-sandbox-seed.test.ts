import { join } from "node:path";
import { ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";
import {
  agentTextNode,
  canvasDoc,
  createSandbox,
  destroySandbox,
  taskItem,
  tasksNode,
  writeFixtureAgentSignals,
  writeFixtureCanvas,
  writeFixtureUsageState,
} from "../e2e/harness/sandbox";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/junto/state/engine";
import { reconstructCanvasDoc } from "../src/main/junto/canvas/records";

describe("E2E SQLite fixture seeding", () => {
  it("keeps work out of authorial canvas rows and starts active work by ActorRef", async () => {
    const sandbox = await createSandbox();
    try {
      await writeFixtureCanvas(
        sandbox,
        "fixture",
        canvasDoc(
          [
            agentTextNode({
              id: "actor",
              key: "local:default",
              label: "actor",
            }),
            tasksNode({
              id: "tasks",
              items: [taskItem("task-1", "ship", "working")],
            }),
          ],
          [{ id: "edge", fromNode: "actor", toNode: "tasks" }],
        ),
      );

      const runtime = ManagedRuntime.make(
        makeStateEngineLive(
          join(sandbox.homeDir, ".junto", "state", "junto.db"),
        ),
      );
      try {
        const state = await runtime.runPromise(StateEngine);
        const witness = await runtime.runPromise(
          state.read("test.e2e-fixture-witness", (reader) => {
            const document = reader.get<{ readonly canvas_id: string }>(
              `SELECT canvas_id
                 FROM canvas_documents
                WHERE canvas_name = 'fixture'`,
            );
            const canvas =
              document === undefined
                ? undefined
                : reconstructCanvasDoc(reader, document.canvas_id);
            const task = reader.get<{
              readonly state: string;
              readonly actor_seat_id: string | null;
            }>(
              `SELECT state, actor_seat_id
                 FROM work_tasks
                WHERE canvas_name = 'fixture'
                  AND node_id = 'tasks'
                  AND task_id = 'task-1'`,
            );
            return { canvas, task };
          }),
        );

        expect(witness.task).toMatchObject({
          state: "working",
          actor_seat_id: expect.stringMatching(/^seat_[a-f0-9]{64}$/),
        });
        expect(
          witness.canvas?.nodes.find((node) => node.id === "tasks")?.ether
            ?.tasks?.items,
        ).toBeUndefined();
      } finally {
        await runtime.dispose();
      }
    } finally {
      await destroySandbox(sandbox);
    }
  });

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
