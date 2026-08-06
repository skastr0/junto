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
  writeFixtureCanvas,
} from "../e2e/harness/sandbox";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum/state/engine";

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
          join(sandbox.homeDir, ".vellum-command", "state", "vellum.db"),
        ),
      );
      try {
        const state = await runtime.runPromise(StateEngine);
        const witness = await runtime.runPromise(
          state.read("test.e2e-fixture-witness", (reader) => {
            const canvas = reader.get<{ readonly body: string }>(
              `SELECT d.body
                 FROM canvas_head h
                 JOIN canvas_generation_documents d
                   ON d.generation = h.generation
                WHERE h.singleton = 1 AND d.name = 'fixture'`,
            );
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
        const authored = JSON.parse(witness.canvas!.body) as {
          readonly nodes: ReadonlyArray<{
            readonly id: string;
            readonly ether?: { readonly tasks?: unknown };
          }>;
        };
        expect(
          authored.nodes.find((node) => node.id === "tasks")?.ether?.tasks,
        ).toBeUndefined();
      } finally {
        await runtime.dispose();
      }
    } finally {
      await destroySandbox(sandbox);
    }
  });
});
