/**
 * Deleting an Automations node archives its automations in the same canvas
 * change, keeps their firings, and is never refused for holding them (07).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { AutomationRepository, makeAutomationRepositoryLive } from "../src/main/junto/automation/repository";
import { ModelDependents } from "../src/main/junto/model/dependents";
import { ModelLive } from "../src/main/junto/model/layer";
import { ModelService } from "../src/main/junto/model/service";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { type Automation, AutomationId, AutomationVersion, FiringId } from "../src/shared/automation";
import { Command } from "../src/shared/model";
import { Automations } from "../src/shared/model/kinds";
import { asNodeId } from "../src/shared/physics/schema";

const command = Schema.decodeUnknownSync(Command);
const ID = Schema.decodeUnknownSync(AutomationId)("01M5ESKJFC1A88R1MH1NEZWJ2Q");
const NODE = "automations-1";

const automation: Automation = {
  automationId: ID,
  nodeId: asNodeId(NODE),
  author: { kind: "operator" },
  version: AutomationVersion.make(1),
  name: "Standup",
  enabled: true,
  trigger: { kind: "schedule", cron: "0 9 * * *", timezone: "UTC" },
  then: [{ kind: "mail", to: { kind: "seat", nodeId: asNodeId("agent-a") }, text: "Plan?" }],
  limits: { minIntervalMs: 60_000, maxPerHour: 12 },
};

const run = async (test: (runtime: ManagedRuntime.ManagedRuntime<ModelService | AutomationRepository, unknown>) => Promise<void>) => {
  const home = await mkdtemp(join(tmpdir(), "junto-automations-delete-"));
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(Layer.provide(ModelLive, ModelDependents.empty), makeAutomationRepositoryLive()).pipe(
      Layer.provideMerge(makeStateEngineLive(join(home, "junto.db"))),
    ),
  );
  try {
    await test(runtime);
  } finally {
    await runtime.dispose();
    await rm(home, { recursive: true, force: true });
  }
};

const OTHER = Schema.decodeUnknownSync(AutomationId)("01M5ESKJFC1A88R1MH1NEZWJ2R");
const ARCHIVED = Schema.decodeUnknownSync(AutomationId)("01M5ESKJFC1A88R1MH1NEZWJ2S");

describe("deleting an Automations node", () => {
  it("archives its automations and keeps their firings", () =>
    run(async (runtime) => {
      await runtime.runPromise(
        Effect.gen(function* () {
          const model = yield* ModelService;
          const automations = yield* AutomationRepository;
          yield* model.command(command({ _tag: "CreateCanvas", canvas: "factory" }), "operator");
          const node = Schema.decodeUnknownSync(Automations)({ kind: "automations", id: NODE, x: 0, y: 0, width: 240, height: 160, z: 0 });
          yield* model.command(command({ _tag: "Add", canvas: "factory", nodes: [node], wires: [] }), "operator");
          yield* automations.applyFacts("factory", [{ fact: "automation.created", automation, at: 1 }]);
          yield* automations.claimFiring("factory", {
            firingId: FiringId.make("01M5ESKJFC1A88R1MH1NEZWJ30"),
            automationId: ID,
            at: 2,
            cause: { kind: "run" },
            outcome: { kind: "fired", actions: [] },
          });

          yield* model.command(command({ _tag: "Remove", canvas: "factory", nodes: [NODE], wires: [] }), "operator");

          expect(yield* automations.list("factory", asNodeId(NODE))).toEqual([]);
          expect((yield* automations.loadState("factory")).get(ID)?.archived).toBe(true);
          expect(yield* automations.firings("factory", { automationId: ID })).toHaveLength(1);
        }),
      );
    }));

  it("is undone by putting the node back: exactly what the delete archived returns, each as it was", () =>
    run(async (runtime) => {
      await runtime.runPromise(
        Effect.gen(function* () {
          const model = yield* ModelService;
          const automations = yield* AutomationRepository;
          yield* model.command(command({ _tag: "CreateCanvas", canvas: "factory" }), "operator");
          const node = Schema.decodeUnknownSync(Automations)({ kind: "automations", id: NODE, x: 0, y: 0, width: 240, height: 160, z: 0 });
          yield* model.command(command({ _tag: "Add", canvas: "factory", nodes: [node], wires: [] }), "operator");
          yield* automations.applyFacts("factory", [
            { fact: "automation.created", automation, at: 1 },
            { fact: "automation.created", automation: { ...automation, automationId: OTHER, name: "Off", enabled: false }, at: 1 },
            { fact: "automation.created", automation: { ...automation, automationId: ARCHIVED, name: "Gone" }, at: 1 },
            // The operator archived this one before the delete.
            { fact: "automation.archived", automationId: ARCHIVED, at: 2 },
          ]);

          yield* model.command(command({ _tag: "Remove", canvas: "factory", nodes: [NODE], wires: [] }), "operator");
          expect(yield* automations.list("factory", asNodeId(NODE))).toEqual([]);
          // Undo: the same node, added back.
          yield* model.command(command({ _tag: "Add", canvas: "factory", nodes: [node], wires: [] }), "operator");

          const back = yield* automations.list("factory", asNodeId(NODE));
          expect(back.map((a) => [a.name, a.enabled]).sort()).toEqual([["Off", false], ["Standup", true]]);
          expect((yield* automations.loadState("factory")).get(ARCHIVED)?.archived).toBe(true);
        }),
      );
    }));
});
