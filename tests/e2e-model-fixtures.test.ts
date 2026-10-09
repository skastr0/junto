import type { Page } from "@playwright/test";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { expect, it, vi } from "vitest";
import { createSandbox, destroySandbox, writeFixtureModel } from "../e2e/harness/sandbox";
import { installModelFixture, modelFixture, modelSeatSession, modelMessagesWire, modelNote, modelRegion, modelSeat, modelTerminal, modelWire, readModelCanvas, commandModel, modelNode } from "../e2e/harness/model";
import { ModelService } from "../src/main/junto/model/service";
import { ModelDependents } from "../src/main/junto/model/dependents";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { makeSeatSessionRepositoryLive, SeatSessionRepository } from "../src/main/junto/seat-sessions/repository";
import { Command, Wire } from "../src/shared/model";

it("seeds native kinds and sink names into the durable model, keeping grids separate", async () => {
  const sandbox = await createSandbox();
  try {
    const rows = [modelRegion({ id: "region", label: "Lab", instruction: "Keep receipts" }),
      modelSeat({ id: "seat-a", key: "local:a", label: "A" }),
      modelSeat({ id: "seat-b" }),
      modelTerminal({ id: "shell", bindingId: "shell", label: "Shell" })];
    await writeFixtureModel(sandbox, "native", modelFixture(rows, [modelMessagesWire("mail", "seat-a", "seat-b", rows, ["msg.list"])], [modelSeatSession(rows[1] as never, "named-session")]));
    const frame = { x: 0, y: 0, width: 240, height: 100, z: 0 };
    const grid = { columns: [{ id: "c", name: "Value" }], rows: [{ id: "r", cells: { c: "123" } }] };
    await writeFixtureModel(sandbox, "sinks", { ...modelFixture([
      modelNode({ ...frame, id: "task", kind: "task", name: "Board", contract: { rules: [] } }),
      modelNode({ ...frame, id: "requests", kind: "requests", name: "Inbox" }),
      modelNode({ ...frame, id: "sheet", kind: "sheet", label: "Grid" }),
    ]), sheets: { sheet: grid } });
    const runtime = ManagedRuntime.make(Layer.provideMerge(Layer.provide(ModelService.layer, ModelDependents.empty), Layer.provideMerge(makeSeatSessionRepositoryLive(join(sandbox.homeDir, ".junto", "seats")), makeStateEngineLive(join(sandbox.homeDir, ".junto", "state", "junto.db")))));
    try {
      await runtime.runPromise(Effect.gen(function* () {
        const model = yield* ModelService;
        const native = yield* model.open("native");
        expect(native.nodes.map((node) => node.kind)).toEqual(["region", "agent", "agent", "terminal"]);
        expect(native.nodes[1]).toMatchObject({ label: "A", bindingId: "local:a", harness: "codex" });
        expect(native.nodes[1]).not.toHaveProperty("sessionId");
        expect(yield* Effect.flatMap(SeatSessionRepository, repo => repo.current("seat-a", "local:a"))).toMatchObject({ sessionId: "named-session" });
        expect(native.nodes[2]).toMatchObject({ label: "seat-b", agentKey: "local:seat-b", bindingId: "local:seat-b" });
        expect(native.wires).toMatchObject([{ from: "seat-a", to: "seat-b", verb: "messages", mask: ["msg.list"] }]);
        const sinks = yield* model.open("sinks");
        expect(sinks.nodes.find((node) => node.id === "task")).toMatchObject({ kind: "task", name: "Board", contract: { rules: [] } });
        expect(sinks.nodes.find((node) => node.id === "requests")).toMatchObject({ kind: "requests", name: "Inbox" });
        expect(sinks.nodes.find((node) => node.id === "sheet")).not.toHaveProperty("rows");
        expect(yield* model.readSheet("sinks", "sheet")).toEqual(grid);
      }));
    } finally { await runtime.dispose(); }
  } finally { await destroySandbox(sandbox); }
});

it("refuses invalid fixture relationships and rolls back a replacement that cannot be installed", async () => {
  const region = modelRegion({ id: "region" });
  const seat = modelSeat({ id: "seat", key: "local:a", label: "A" });
  expect(() => modelWire("bad", region.id, seat.id, "messages", [region, seat])).toThrow("allowed relationship");
  const sandbox = await createSandbox();
  try {
    await writeFixtureModel(sandbox, "proof", modelFixture([seat]));
    const invalid = Schema.decodeUnknownSync(Wire)({ id: "missing-end", from: seat.id, to: "missing", verb: "messages" });
    await expect(writeFixtureModel(sandbox, "proof", modelFixture([seat], [invalid]))).rejects.toThrow();
    const runtime = ManagedRuntime.make(Layer.provideMerge(Layer.provide(ModelService.layer, ModelDependents.empty), makeStateEngineLive(join(sandbox.homeDir, ".junto", "state", "junto.db"))));
    try {
      const opened = await runtime.runPromise(Effect.flatMap(ModelService, (model) => model.open("proof")));
      expect(opened.nodes).toEqual([seat]);
    } finally { await runtime.dispose(); }
  } finally { await destroySandbox(sandbox); }
});

it("installs a native scenario topology in one event and rolls back an invalid replacement", async () => {
  const sandbox = await createSandbox();
  try {
    await writeFixtureModel(sandbox, "proof", modelFixture([modelNote("old", "Before")]));
    const runtime = ManagedRuntime.make(Layer.provideMerge(Layer.provide(ModelService.layer, ModelDependents.empty), makeStateEngineLive(join(sandbox.homeDir, ".junto", "state", "junto.db"))));
    try {
      const model = await runtime.runPromise(ModelService);
      const events: unknown[] = [];
      const stop = model.subscribeChanges((event) => events.push(event));
      vi.stubGlobal("window", { junto: {
        modelCanvases: async () => (await runtime.runPromise(model.listCanvases())).map((name) => ({ name })),
        modelOpen: ({ canvas }: { canvas: string }) => runtime.runPromise(model.open(canvas)),
        modelCommand: (command: unknown) => runtime.runPromise(model.command(Schema.decodeUnknownSync(Command)(command), "operator")),
      } });
      const page = { evaluate: (fn: (input: unknown) => unknown, input: unknown) => Promise.resolve(fn(input)) } as unknown as Page;
      try {
        const rows = [modelSeat({ id: "a", key: "local:a", label: "A" }), modelSeat({ id: "b", key: "local:b", label: "B" })];
        const fixture = modelFixture(rows, [modelWire("mail", "a", "b", "messages", rows)]);
        expect(await installModelFixture(page, fixture)).toBe("proof");
        expect(events).toHaveLength(1);
        const before = await runtime.runPromise(model.open("proof"));
        expect(before.nodes).toEqual(fixture.nodes);
        expect(before.wires).toEqual(fixture.wires);
        const bad = Schema.decodeUnknownSync(Wire)({ id: "bad", from: "a", to: "absent", verb: "messages" });
        await expect(installModelFixture(page, modelFixture(rows, [bad]))).rejects.toThrow();
        expect(await runtime.runPromise(model.open("proof"))).toEqual(before);
        expect(events).toHaveLength(1);
      } finally { stop(); vi.unstubAllGlobals(); }
    } finally { await runtime.dispose(); }
  } finally { await destroySandbox(sandbox); }
});


it("applies a native fixture edit in one event and refuses authored runtime session fields", async () => {
  const sandbox = await createSandbox();
  try {
    await writeFixtureModel(sandbox, "proof", modelFixture([modelNote("note", "before"), modelSeat({ id: "seat", key: "local:a", label: "A" })]));
    const runtime = ManagedRuntime.make(Layer.provideMerge(Layer.provide(ModelService.layer, ModelDependents.empty), makeStateEngineLive(join(sandbox.homeDir, ".junto", "state", "junto.db"))));
    try {
      const model = await runtime.runPromise(ModelService);
      const events: unknown[] = [];
      const stop = model.subscribeChanges((event) => events.push(event));
      vi.stubGlobal("window", { junto: {
        modelOpen: ({ canvas }: { canvas: string }) => runtime.runPromise(model.open(canvas)),
        modelCommand: (command: unknown) => runtime.runPromise(model.command(Schema.decodeUnknownSync(Command)(command), "operator")),
      } });
      const page = { evaluate: (fn: (input: unknown) => unknown, input: unknown) => Promise.resolve(fn(input)) } as unknown as Page;
      try {
        const { seq } = await commandModel(page, { _tag: "Batch", canvas: "proof", steps: [
          { _tag: "Edit", canvas: "proof", id: "note", change: { kind: "note", text: "after" } },
          { _tag: "Move", canvas: "proof", moves: [{ id: "note", x: 80, y: 0 }] },
          { _tag: "Recolor", canvas: "proof", nodes: ["note"], color: "4" },
          { _tag: "Restack", canvas: "proof", nodes: ["note"], to: "front" },
        ] });
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ seq, nodes: expect.arrayContaining([{ ...modelNote("note", "after", 80, 0), color: "4", z: 2 }]) });
        expect((await runtime.runPromise(model.open("proof"))).nodes.map((node) => node.id)).toEqual(["seat", "note"]);
        const edited = await readModelCanvas(page, "proof");
        await expect(commandModel(page, { _tag: "Edit", canvas: "proof", id: "seat", change: { kind: "agent", sessionId: "invented" } })).rejects.toThrow(/sessionId/);
        expect(await readModelCanvas(page, "proof")).toEqual(edited);
        expect(events).toHaveLength(1);
      } finally { stop(); vi.unstubAllGlobals(); }
    } finally { await runtime.dispose(); }
  } finally { await destroySandbox(sandbox); }
});
