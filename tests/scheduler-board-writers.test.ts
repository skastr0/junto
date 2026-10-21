import { afterEach, describe, expect, it, vi } from "vitest";
import { asCanvasName, type Node, type NodeOf } from "../src/shared/model";
import { setBoardSettings } from "../src/renderer/lib/mutations";
import { modelStore } from "../src/renderer/lib/use-model";
import { state$ } from "../src/renderer/lib/state";
import { note, taskBoard } from "./support/model-nodes";

const name = "scheduler-board-writers";
const place = { x: 90, y: 140, width: 360, height: 200, z: 3, color: "4" as const };
let release: (() => void) | undefined;
const open = (node: Node) => {
  state$.canvasName.set(name);
  state$.error.set("");
  release = modelStore.adopt({ canvas: asCanvasName(name), seq: 21, nodes: [node], wires: [] });
  return node;
};
const held = () => modelStore.canvasOf(name).nodes.values().next().value!;
afterEach(() => { release?.(); vi.restoreAllMocks(); state$.error.set(""); state$.saveState.set("saved"); });

describe("board writers change their fields alone", () => {
  it("board settings set, repeat and clear change contract only", () => {
    const before = open(taskBoard("target", { ...place, name: "Backlog", contract: { instructions: "Review first.", rules: [{ id: "r1", text: "Keep scope." }], incoming: { waitMs: 600 }, outgoing: { checks: [] } } })) as NodeOf<"task">;
    const show = vi.spyOn(modelStore, "show");
    const contract = { ...before.contract, instructions: "Ship after review." };
    setBoardSettings("target", contract);
    expect(held()).toEqual({ ...before, contract });
    expect(show).toHaveBeenCalledExactlyOnceWith({ _tag: "Edit", canvas: name, id: before.id, change: { kind: "task", contract } });
    setBoardSettings("target", contract); expect(show).toHaveBeenCalledTimes(1);
    setBoardSettings("target", {});
    const { contract: _gone, ...cleared } = before;
    expect(held()).toEqual(cleared);
    setBoardSettings("target", undefined); expect(show).toHaveBeenCalledTimes(2);
  });

  it("other kinds and missing nodes stay untouched", () => {
    const before = open(note("target"));
    const show = vi.spyOn(modelStore, "show");
    for (const id of ["target", "missing"]) {
      setBoardSettings(id, { instructions: "Ship." });
    }
    expect(held()).toEqual(before); expect(show).not.toHaveBeenCalled();
  });
});
