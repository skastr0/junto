import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../../src/shared/canvas";
import type { Task } from "../../src/shared/work-model";
import {
  cliCoverageManifest,
  expectedCliAuthorizationCellCount,
  generateCliAuthorizationMatrix,
} from "./matrix";
import {
  runFactoryScenario,
  type FactoryScenario,
  type ScenarioEvent,
} from "./harness";

const task: Task = {
  id: "task-1",
  state: "submitted",
  history: [
    {
      messageId: "message-1",
      role: "user",
      parts: [{ kind: "text", text: "Prove the deterministic factory loop" }],
      taskId: "task-1",
    },
  ],
};

const canvas: CanvasDoc = {
  nodes: [
    {
      id: "agent",
      type: "text",
      text: "simulated agent",
      x: 0,
      y: 0,
      width: 180,
      height: 80,
      ether: {
        entity: { kind: "agent", name: "local:factory-sim" },
        terminal: { bindingId: "binding-factory-sim", harness: "claude" },
      },
    },
    {
      id: "tasks",
      type: "text",
      text: "tasks",
      x: 240,
      y: 0,
      width: 180,
      height: 80,
      ether: { entity: { kind: "task" } },
    },
    {
      id: "orphan",
      type: "text",
      text: "orphan tasks",
      x: 480,
      y: 0,
      width: 180,
      height: 80,
      ether: { entity: { kind: "task" } },
    },
  ],
  // The sink works through this seat: only that verb puts it in the labor
  // pool the factory tick assigns from. A seat that merely contributes could
  // claim by hand and would never be handed this task.
  edges: [
    {
      id: "edge-agent-tasks",
      fromNode: "tasks",
      toNode: "agent",
      ether: { verb: "works" },
    },
  ],
};

const scenario: FactoryScenario = {
  name: "one task reaches one fake managed actor",
  canvasName: "factory-sim",
  canvas,
  actor: {
    nodeId: "agent",
    agentKey: "local:factory-sim",
    bindingId: "binding-factory-sim",
  },
  tasks: [{ sinkNodeId: "tasks", task }],
  ticks: [
    { commands: [{ commandId: "tasks.list", input: { target: "tasks" } }] },
    { commands: [{ commandId: "tasks.list", input: { target: "orphan" } }] },
    {
      commands: [
        {
          commandId: "tasks.update",
          input: {
            target: "tasks",
            task: "task-1",
            state: "completed",
            note: "completed by the scripted fake actor",
          },
        },
      ],
    },
    {},
  ],
};

const deterministicTrace = (events: ReadonlyArray<ScenarioEvent>) =>
  events.map((event) =>
    event.kind === "cli.result"
      ? {
          tick: event.tick,
          kind: event.kind,
          commandId: event.commandId,
          exitCode: event.exitCode,
          ok: event.response.ok,
          errorType: event.response.ok ? undefined : event.response.error.type,
        }
      : event.kind === "injection.accepted"
        ? { ...event, deliveryId: "<derived-delivery-id>" }
      : event,
  );

describe("external factory simulator prototype", () => {
  it("classifies every current Vellum Command CLI subcommand into a conformance lane", () => {
    const manifest = cliCoverageManifest();
    expect(manifest.length).toBeGreaterThan(0);
    expect(new Set(manifest.map(({ commandId }) => commandId)).size).toBe(manifest.length);
    expect(manifest.filter(({ lane }) => lane === undefined)).toEqual([]);
    expect(manifest).toContainEqual({ commandId: "tasks.claim", lane: "target-matrix" });
    expect(manifest).toContainEqual({ commandId: "doctor", lane: "seat-local" });
  });

  it("exhausts the current node-edge-node matrix for every target-scoped CLI command", () => {
    const matrix = generateCliAuthorizationMatrix();
    expect(matrix).toHaveLength(expectedCliAuthorizationCellCount());
    expect(new Set(matrix.map((cell) => JSON.stringify([
      cell.commandId,
      cell.sourceKind,
      cell.targetKind,
      cell.direction,
      cell.edgeMode,
    ]))).size).toBe(matrix.length);
    expect(matrix.filter(({ expected, actual }) => expected !== actual)).toEqual([]);
    expect(matrix.some((cell) => cell.actual === "allow")).toBe(true);
    expect(matrix.some((cell) => cell.actual === "deny")).toBe(true);
  });

  it("runs claim, PTY injection, hook acknowledgement, real control calls, and durable ticks", async () => {
    const run = await runFactoryScenario(scenario);

    expect(run.snapshots.map(({ tasks }) => tasks["task-1"])).toEqual([
      "working",
      "working",
      "completed",
      "completed",
    ]);
    expect(run.events.filter(({ kind }) => kind === "claim")).toHaveLength(1);
    expect(run.events.filter(({ kind }) => kind === "injection.accepted")).toHaveLength(1);
    expect(run.events.filter(({ kind }) => kind === "hook.turn-start")).toHaveLength(1);
    expect(run.events.filter(({ kind }) => kind === "pty.write")).toHaveLength(2);

    const results = run.events.filter(({ kind }) => kind === "cli.result");
    expect(results).toHaveLength(3);
    expect(results[0]?.response.ok).toBe(true);
    expect(results[0]?.exitCode).toBe(0);
    expect(results[1]?.response).toMatchObject({
      ok: false,
      error: { type: "ScopeError" },
    });
    expect(results[1]?.exitCode).toBe(1);
    expect(results[2]?.response.ok).toBe(true);
    expect(results[2]?.exitCode).toBe(0);

    const replay = await runFactoryScenario(scenario);
    expect(deterministicTrace(replay.events)).toEqual(deterministicTrace(run.events));
  });
});
