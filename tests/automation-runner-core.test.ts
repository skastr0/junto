/**
 * The automation runner as the machine core builds it (0.11/05 S2): on a
 * machine that holds only a copy, an automation placed there queues its task
 * write through the machine's submit path. Built in the product layer, under
 * the machine services, the runner saw no submit path and refused every such
 * write not_available.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { makeCoreRuntime } from "../src/main/core-runtime";
import { AutomationRunnerService } from "../src/main/junto/automation/live";
import { submitAutomationCommand } from "../src/main/junto/automation/ruler";
import { MachineRepository } from "../src/main/junto/machines/repository";
import { ModelService } from "../src/main/junto/model/service";
import { AutomationId, type AutomationDefinition, type AutomationOp } from "../src/shared/automation";
import { Command } from "../src/shared/model";
import { asNodeId } from "../src/shared/physics/schema";
import type { ResourceCommand } from "../src/shared/resource-command";
import { OpId } from "../src/shared/work-ids";

const command = Schema.decodeUnknownSync(Command);
const NIGHTLY = Schema.decodeUnknownSync(AutomationId)("01M62AEEEEEEEEEEEEEEEEEEEE");

it("queues an automation's task write off the editing machine, through the core's submit path", async () => {
  const home = await mkdtemp("/tmp/junto-runner-core-");
  const runtime = makeCoreRuntime({ home, build: "a".repeat(64), bundles: {}, ready: () => false });
  try {
    const [model, machines] = await runtime.runPromise(Effect.all([ModelService, MachineRepository]));
    await runtime.runPromise(model.command(command({ _tag: "CreateCanvas", canvas: "factory" }), "operator"));
    await runtime.runPromise(model.command(command({ _tag: "Add", canvas: "factory", nodes: [
      { kind: "automations", id: "routines", x: 0, y: 0, width: 240, height: 160, z: 0 },
      { kind: "task", id: "board", x: 300, y: 0, width: 240, height: 160, z: 0 },
    ], wires: [] }), "operator"));
    const self = await runtime.runPromise(machines.installationId);
    const here = await runtime.runPromise(machines.machineName);
    const definition: AutomationDefinition = {
      name: "Nightly",
      trigger: { kind: "schedule", cron: "0 2 * * *", timezone: "UTC" },
      then: [{ kind: "create-task", node: asNodeId("board"), title: "Filed off the editor" }],
      limits: { minIntervalMs: 60_000, maxPerHour: 12 },
    };
    // Ruled as the editing machine would, placed on this machine.
    const created = await runtime.runPromise(submitAutomationCommand(
      self,
      {
        opId: OpId.make("01M62AEEEEEEEEEEEEEEEEEEE1"),
        canvasName: "factory",
        actor: { kind: "operator" },
        target: { kind: "automation", nodeId: asNodeId("routines") },
        basis: null,
        after: [],
        op: { kind: "create", automationId: NIGHTLY, enabled: true, machine: here, definition },
      } as unknown as ResourceCommand<AutomationOp>,
      { inReach: () => true },
      { targetsOf: () => new Set([asNodeId("board")]), isOverseer: () => false },
    ));
    expect(created.kind).toBe("applied");
    // Another machine edits the canvas now: this one holds a copy.
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => Effect.gen(function* () {
      yield* sql`INSERT INTO known_installations(installation_id, registered_at) VALUES ('editor-installation', '2026-10-28T12:00:00.000Z')`;
      yield* sql`UPDATE canvases SET editor_installation_id = 'editor-installation' WHERE canvas_name = 'factory'`;
    })));

    const firing = await runtime.runPromise(Effect.flatMap(AutomationRunnerService, (runner) => runner.onRun("factory", NIGHTLY)));
    expect(firing?.outcome).toEqual({ kind: "fired", actions: [{ index: 0, ruling: "queued" }] });
  } finally {
    await runtime.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
