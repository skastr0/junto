import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Command } from "../src/shared/model";
import { modelNote } from "../e2e/harness/model";
import { ModelLive } from "../src/main/junto/model/layer";
import { ModelDependents } from "../src/main/junto/model/dependents";
import { ModelService } from "../src/main/junto/model/service";
import { makeStateEngineLive } from "../src/main/junto/state/engine";

const run = async (test: (model: ModelService["Service"], runtime: ReturnType<typeof makeRuntime>) => Promise<void>) => {
  const home = await mkdtemp(join(tmpdir(), "junto-model-remove-"));
  const runtime = makeRuntime(join(home, "junto.db"));
  try { await test(await runtime.runPromise(ModelService), runtime); }
  finally { await runtime.dispose(); await rm(home, { recursive: true, force: true }); }
};
const makeRuntime = (path: string) => ManagedRuntime.make(Layer.provideMerge(
  Layer.provide(ModelLive, ModelDependents.empty), makeStateEngineLive(path),
));
const command = Schema.decodeUnknownSync(Command);

describe("model canvas removal", () => {
  it("removes a canvas and its nodes, without touching another canvas", () => run(async (model, runtime) => {
    for (const canvas of ["keep", "drop"]) {
      await runtime.runPromise(model.command(command({ _tag: "CreateCanvas", canvas }), "operator"));
      await runtime.runPromise(model.command(command({ _tag: "Add", canvas, nodes: [modelNote("same", canvas)], wires: [] }), "operator"));
    }
    await runtime.runPromise(model.command(command({ _tag: "RemoveCanvas", canvas: "drop" }), "operator"));
    expect(await runtime.runPromise(model.listCanvases())).toEqual(["keep"]);
    expect((await runtime.runPromise(model.open("keep"))).nodes).toMatchObject([{ id: "same", text: "keep" }]);
    await expect(runtime.runPromise(model.open("drop"))).rejects.toThrow();
  }));

  it("refuses removal of a missing canvas", () => run(async (model, runtime) => {
    const result = await runtime.runPromise(Effect.result(model.command(command({ _tag: "RemoveCanvas", canvas: "missing" }), "operator")));
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ModelNotFound" } });
  }));

  it("rejects an invalid name at the command boundary", () => {
    expect(() => command({ _tag: "RemoveCanvas", canvas: "Bad Name!" })).toThrow();
  });

  it("publishes exactly one removal event after the canvas is gone", () => run(async (model, runtime) => {
    await runtime.runPromise(model.command(command({ _tag: "CreateCanvas", canvas: "drop" }), "operator"));
    const seen: string[] = [];
    const stop = model.subscribeCanvasesChanges((event) => seen.push(event._tag + ":" + event.canvas));
    try {
      await runtime.runPromise(model.command(command({ _tag: "RemoveCanvas", canvas: "drop" }), "operator"));
      expect(seen).toEqual(["Removed:drop"]);
      expect(await runtime.runPromise(model.listCanvases())).toEqual([]);
    } finally { stop(); }
  }));

  it("a throwing subscriber cannot undo a committed removal", () => run(async (model, runtime) => {
    await runtime.runPromise(model.command(command({ _tag: "CreateCanvas", canvas: "drop" }), "operator"));
    const stop = model.subscribeCanvasesChanges(() => { throw new Error("listener failed"); });
    try {
      await expect(runtime.runPromise(model.command(command({ _tag: "RemoveCanvas", canvas: "drop" }), "operator"))).resolves.toBeDefined();
      expect(await runtime.runPromise(model.listCanvases())).toEqual([]);
    } finally { stop(); }
  }));

  it("a racing edit cannot resurrect a removed canvas", () => run(async (model, runtime) => {
    await runtime.runPromise(model.command(command({ _tag: "CreateCanvas", canvas: "drop" }), "operator"));
    const results = await Promise.allSettled([
      runtime.runPromise(model.command(command({ _tag: "Add", canvas: "drop", nodes: [modelNote("note", "late")], wires: [] }), "operator")),
      runtime.runPromise(model.command(command({ _tag: "RemoveCanvas", canvas: "drop" }), "operator")),
    ]);
    expect(results[1].status).toBe("fulfilled");
    expect(await runtime.runPromise(model.listCanvases())).toEqual([]);
    await expect(runtime.runPromise(model.open("drop"))).rejects.toThrow();
  }));
});
