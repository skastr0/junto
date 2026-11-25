import { describe, expect, it } from "vitest";
import { countTakeoverPlacement, type TakeoverSource } from "../src/shared/machine-takeover";
import type { Canvas, Node } from "../src/shared/model";

const node = (id: string, kind: "agent" | "peer" | "files" | "note", host: string): Node =>
  (kind === "note"
    ? { id, kind, x: 0, y: 0, z: 0, label: id, text: "" }
    : kind === "files"
      ? { id, kind, x: 0, y: 0, z: 0, label: id, host, root: "/tmp" }
      : { id, kind, x: 0, y: 0, z: 0, label: id, host, ...(kind === "agent" ? { agentKey: "local:claude", overseer: false, bindingId: id, harness: "claude", launch: null } : { seatId: id }) }) as Node;

const source = (nodes: ReadonlyArray<Node>, automations: ReadonlyArray<TakeoverSource["automations"] extends ReadonlyMap<string, infer E> ? E : never>): TakeoverSource => ({
  canvas: { name: "factory", seq: 0, nodes: new Map(nodes.map((entry) => [entry.id, entry])), wires: new Map() } as unknown as Canvas,
  automations: new Map(automations.map((entry, index) => [`a${index}`, entry])),
});

describe("countTakeoverPlacement", () => {
  it("counts seats and unarchived automations the far canvases place on the name", () => {
    const sources = [
      source(
        [node("a", "agent", "near"), node("b", "peer", "near"), node("c", "agent", "far"), node("f", "files", "near"), node("n", "note", "near")],
        [
          { archived: false, automation: { machine: "near" } },
          { archived: true, automation: { machine: "near" } },
          { archived: false, automation: { machine: "far" } },
        ],
      ),
    ];
    expect(countTakeoverPlacement("near", sources)).toEqual({ seats: 2, automations: 1, files: 1 });
  });
});

describe("takeover counts on the real state engine", () => {
  it("reads canvases and automations inside the retire transaction without waiting on its own writer", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Effect, Layer, ManagedRuntime, Schema } = await import("effect");
    const { SqlClient } = await import("effect/sql");
    const { ModelService } = await import("../src/core/model/service");
    const { ModelDependents } = await import("../src/core/model/dependents");
    const { AutomationRepository, makeAutomationRepositoryLive } = await import("../src/core/automation/repository");
    const { makeStateEngineLive } = await import("../src/core/state/engine");
    const { makeMachineRepositoryLive } = await import("../src/core/machines/repository");
    const { Command } = await import("../src/shared/model");
    const { AutomationId, AutomationVersion } = await import("../src/shared/automation");
    const { asNodeId } = await import("../src/shared/physics/schema");
    const root = await mkdtemp(join(tmpdir(), "takeover-counts-"));
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(Layer.provide(ModelService.layer, ModelDependents.empty), makeAutomationRepositoryLive(), makeMachineRepositoryLive({ defaultName: () => "command" }))
        .pipe(Layer.provideMerge(makeStateEngineLive(join(root, "junto.db")))),
    );
    try {
      const result = await runtime.runPromise(Effect.gen(function* () {
        const model = yield* ModelService;
        const automations = yield* AutomationRepository;
        const sql = yield* SqlClient.SqlClient;
        yield* model.ensureSeed;
        const canvas = (yield* model.listCanvases())[0]!;
        yield* model.command(Schema.decodeUnknownSync(Command)({
          _tag: "Add", canvas, wires: [], nodes: [{
            kind: "agent", id: "seat-1", x: 0, y: 0, width: 240, height: 120, z: 0, label: "Seat",
            agentKey: "command:claude", host: "command", overseer: false, bindingId: "seat-binding", harness: "claude", launch: { kind: "harness" },
          }, {
            kind: "files", id: "files-1", x: 0, y: 0, width: 240, height: 120, z: 0, label: "Files", host: "command", root: "/tmp",
          }],
        }), "operator");
        const automationId = Schema.decodeUnknownSync(AutomationId)("01M5ESKJFC1A88R1MH1NEZWJ2Q");
        yield* automations.applyFacts(canvas, [{
          fact: "automation.created", at: 1, automation: {
            automationId, nodeId: asNodeId("automations-1"), author: { kind: "operator" },
            version: AutomationVersion.make(1), name: "Standup", enabled: true, machine: "command",
            trigger: { kind: "schedule", cron: "0 9 * * *", timezone: "UTC" },
            then: [{ kind: "mail", to: { kind: "seat", nodeId: asNodeId("seat-1") }, text: "Plan?" }],
            limits: { minIntervalMs: 60_000, maxPerHour: 12 },
          },
        }]);
        return yield* sql.withTransaction(Effect.gen(function* () {
          const sources = [];
          for (const name of yield* model.listCanvases()) {
            sources.push({ canvas: yield* model.canvas(name), automations: yield* automations.loadState(name) });
          }
          return countTakeoverPlacement("command", sources);
        }));
      }));
      expect(result).toEqual({ seats: 1, automations: 1, files: 1 });
    } finally {
      await runtime.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);
});
