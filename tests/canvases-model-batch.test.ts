import { join } from "node:path";
import { Layer, ManagedRuntime, Schema } from "effect";
import { expect, it } from "vitest";
import { createSandbox, destroySandbox, writeFixtureModel } from "../e2e/harness/sandbox";
import { modelFixture, modelNote, modelSeat, modelWire } from "../e2e/harness/model";
import { Command } from "../src/shared/model";
import { ModelLive } from "../src/main/junto/model/layer";
import { ModelDependents } from "../src/main/junto/model/dependents";
import { ModelService } from "../src/main/junto/model/service";
import { makeStateEngineLive } from "../src/main/junto/state/engine";

it("a batch publishes one committed delta for add, move, edit, paint order and wire replacement", async () => {
  const sandbox = await createSandbox();
  try {
    const a = modelSeat({ id: "a", key: "local:a", label: "A" });
    const b = modelSeat({ id: "b", key: "local:b", label: "B" });
    await writeFixtureModel(sandbox, "proof", modelFixture([a, b, modelNote("note", "before")], [modelWire("mail", "a", "b", "messages", [a, b])]));
    const runtime = ManagedRuntime.make(Layer.provideMerge(Layer.provide(ModelLive, ModelDependents.empty), makeStateEngineLive(join(sandbox.homeDir, ".junto", "state", "junto.db"))));
    try {
      const model = await runtime.runPromise(ModelService);
      const seq = (await runtime.runPromise(model.open("proof"))).seq;
      const events: { readonly seq: number }[] = [];
      const stop = model.subscribeChanges((event) => events.push(event));
      try {
        const result = await runtime.runPromise(model.command(Schema.decodeUnknownSync(Command)({
          _tag: "Batch", canvas: "proof", steps: [
            { _tag: "Remove", canvas: "proof", nodes: [], wires: ["mail"] },
            { _tag: "Edit", canvas: "proof", id: "note", change: { kind: "note", text: "after" } },
            { _tag: "Recolor", canvas: "proof", nodes: ["note"], color: "4" },
            { _tag: "Move", canvas: "proof", moves: [{ id: "note", x: 80, y: 0, z: 0 }, { id: "a", x: 0, y: 0, z: 1 }, { id: "b", x: 0, y: 0, z: 2 }] },
            { _tag: "Add", canvas: "proof", nodes: [{ ...modelNote("added", "new", 400), z: 3 }], wires: [modelWire("mail", "b", "a", "messages", [a, b])] },
          ],
        }), "operator"));
        expect(result).toEqual({ seq: seq + 1 });
        expect(events).toEqual([expect.objectContaining({ seq: seq + 1 })]);
        const opened = await runtime.runPromise(model.open("proof"));
        expect(opened.seq).toBe(seq + 1);
        expect(opened.nodes.find((node) => node.id === "note")).toMatchObject({ kind: "note", text: "after", x: 80, color: "4" });
        expect(opened.nodes.find((node) => node.id === "added")).toMatchObject({ kind: "note", text: "new" });
        expect(opened.nodes.map((node) => node.id)).toEqual(["note", "a", "b", "added"]);
        expect(opened.wires).toMatchObject([{ id: "mail", from: "b", to: "a" }]);
      } finally { stop(); }
    } finally { await runtime.dispose(); }
  } finally { await destroySandbox(sandbox); }
});
