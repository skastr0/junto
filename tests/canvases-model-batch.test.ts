import { join } from "node:path";
import { Layer, ManagedRuntime } from "effect";
import { expect, it } from "vitest";
import { createSandbox, destroySandbox, writeFixtureModel } from "../e2e/harness/sandbox";
import { modelFixture, modelNote, modelSeat, modelWire } from "../e2e/harness/model";
import { CanvasesLive, CanvasesService } from "../src/main/junto/canvases";
import { ModelService } from "../src/main/junto/model/service";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";

it("a facade write publishes one committed model delta for add, move, edit, paint order and wire replacement", async () => {
  const sandbox = await createSandbox();
  try {
    const a = modelSeat({ id: "a", key: "local:a", label: "A" });
    const b = modelSeat({ id: "b", key: "local:b", label: "B" });
    await writeFixtureModel(sandbox, "proof", modelFixture([a, b, modelNote("note", "before")], [modelWire("mail", "a", "b", "messages", [a, b])]));
    const runtime = ManagedRuntime.make(Layer.provideMerge(CanvasesLive, Layer.provideMerge(WorkRepositoryLive, makeStateEngineLive(join(sandbox.homeDir, ".junto", "state", "junto.db")))));
    try {
      const canvases = await runtime.runPromise(CanvasesService);
      const model = await runtime.runPromise(ModelService);
      const before = await runtime.runPromise(canvases.read("proof"));
      const seq = (await runtime.runPromise(model.open("proof"))).seq;
      const events: { readonly seq: number }[] = [];
      const stop = model.subscribeChanges((event) => events.push(event));
      try {
        const note = before.doc.nodes.find((node) => node.id === "note")!;
        const remaining = before.doc.nodes.filter((node) => node.id !== "note");
        const result = await runtime.runPromise(canvases.write("proof", {
          nodes: [{ ...note, type: "text", text: "after", x: 80, color: "4" }, ...remaining,
            { id: "added", type: "text", text: "new", x: 400, y: 0, width: 200, height: 90 }],
          edges: [{ id: "mail", fromNode: "b", toNode: "a", ether: { verb: "messages" } }],
        }, before.revision));
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ seq: seq + 1 });
        const opened = await runtime.runPromise(model.open("proof"));
        expect(opened.seq).toBe(seq + 1);
        expect(opened.nodes.find((node) => node.id === "note")).toMatchObject({ kind: "note", text: "after", x: 80, color: "4" });
        expect(opened.nodes.find((node) => node.id === "added")).toMatchObject({ kind: "note", text: "new" });
        expect(opened.nodes.map((node) => node.id)).toEqual(["note", "a", "b", "added"]);
        expect(opened.wires).toMatchObject([{ id: "mail", from: "b", to: "a" }]);
        expect((await runtime.runPromise(canvases.read("proof"))).revision).toBe(result.revision);
      } finally { stop(); }
    } finally { await runtime.dispose(); }
  } finally { await destroySandbox(sandbox); }
});
