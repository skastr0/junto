import type { Page } from "@playwright/test";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { expect, it, vi } from "vitest";
import { createSandbox, destroySandbox, writeFixtureCanvas, writeFixtureModel } from "../e2e/harness/sandbox";
import { installModelFixture, modelFixture, modelNote, modelRegion, modelSeat, modelTerminal, modelWire, readFixtureDocument, writeFixtureDocument } from "../e2e/harness/model";
import { ModelService } from "../src/main/junto/model/service";
import { ModelDependents } from "../src/main/junto/model/dependents";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { Command, Wire } from "../src/shared/model";

it("seeds native kinds and legacy fixtures into the same durable model, keeping grids separate", async () => {
  const sandbox = await createSandbox();
  try {
    const rows = [modelRegion({ id: "region", label: "Lab", instruction: "Keep receipts" }),
      modelSeat({ id: "seat-a", key: "local:a", label: "A", sessionId: "named-session" }),
      modelSeat({ id: "seat-b", key: "local:b", label: "B" }),
      modelTerminal({ id: "shell", bindingId: "shell", label: "Shell" })];
    await writeFixtureModel(sandbox, "native", modelFixture(rows, [modelWire("mail", "seat-a", "seat-b", "messages", rows)]));
    const frame = { x: 0, y: 0, width: 240, height: 100 };
    const grid = { columns: [{ id: "c", name: "Value" }], rows: [{ id: "r", cells: { c: "123" } }] };
    await writeFixtureCanvas(sandbox, "old-seed", { nodes: [
      { ...frame, id: "task", type: "text", text: "Backlog", ether: { entity: { kind: "task", name: "Backlog" }, tasks: { name: "Board", contract: { rules: [] }, items: [] } } },
      { ...frame, id: "requests", type: "text", text: "Requests", ether: { entity: { kind: "requests", name: "Requests" }, requests: { name: "Inbox", items: [] } } },
      { ...frame, id: "sheet", type: "text", text: "Grid", ether: { entity: { kind: "sheet", name: "Grid" }, sheet: grid } },
    ], edges: [] });
    const runtime = ManagedRuntime.make(Layer.provideMerge(Layer.provide(ModelService.layer, ModelDependents.empty), makeStateEngineLive(join(sandbox.homeDir, ".junto", "state", "junto.db"))));
    try {
      await runtime.runPromise(Effect.gen(function* () {
        const model = yield* ModelService;
        const native = yield* model.open("native");
        expect(native.nodes.map((node) => node.kind)).toEqual(["region", "agent", "agent", "terminal"]);
        expect(native.nodes[1]).toMatchObject({ label: "A", bindingId: "local:a", harness: "codex", sessionId: "named-session" });
        expect(native.wires).toMatchObject([{ from: "seat-a", to: "seat-b", verb: "messages" }]);
        const old = yield* model.open("old-seed");
        expect(old.nodes.find((node) => node.id === "task")).toMatchObject({ kind: "task", name: "Board", contract: { rules: [] } });
        expect(old.nodes.find((node) => node.id === "requests")).toMatchObject({ kind: "requests", name: "Inbox" });
        expect(old.nodes.find((node) => node.id === "sheet")).not.toHaveProperty("rows");
        expect(yield* model.readSheet("old-seed", "sheet")).toEqual(grid);
        expect(old.nodes.every((node) => !("ether" in node))).toBe(true);
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


it("converts a live fixture edit into one batch and refuses renderer session stamps", async () => {
  const sandbox = await createSandbox();
  try {
    await writeFixtureModel(sandbox, "proof", modelFixture([modelNote("note", "before"), modelSeat({ id: "seat", key: "local:a", label: "A", sessionId: "runtime-id" })]));
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
        const before = await readFixtureDocument(page, "proof");
        const seq = await writeFixtureDocument(page, "proof", { ...before, nodes: [...before.nodes].reverse().map((node) => node.id === "note" && node.type === "text" ? { ...node, x: 80, color: "4", text: "after" } : node) });
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ seq, nodes: expect.arrayContaining([{ ...modelNote("note", "after", 80, 0), color: "4", z: 1 }]) });
        expect((await runtime.runPromise(model.open("proof"))).nodes.map((node) => node.id)).toEqual(["seat", "note"]);
        const edited = await readFixtureDocument(page, "proof");
        await expect(writeFixtureDocument(page, "proof", { ...edited, nodes: edited.nodes.map((node) => node.id === "seat" ? { ...node, ether: { ...node.ether, terminal: { ...node.ether!.terminal!, sessionId: "invented" } } } : node) })).rejects.toThrow("runtime session");
        expect(events).toHaveLength(1);
      } finally { stop(); vi.unstubAllGlobals(); }
    } finally { await runtime.dispose(); }
  } finally { await destroySandbox(sandbox); }
});
