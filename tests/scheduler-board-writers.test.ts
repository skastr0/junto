import { afterEach, describe, expect, it, vi } from "vitest";
import { asCanvasName, type Node, type NodeOf } from "../src/shared/model";
import { setBoardSettings, setNodeTimer, setNodeWatch } from "../src/renderer/lib/mutations";
import { modelStore } from "../src/renderer/lib/use-model";
import { state$ } from "../src/renderer/lib/state";
import { cron, note, taskBoard, watcher } from "./support/model-nodes";

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

describe("scheduler and board writers change their fields alone", () => {
  it("cron set, repeat and clear change expression only", () => {
    const before = open(cron("target", { ...place, label: "Morning", host: "studio", expression: "0 8 * * *" })) as NodeOf<"cron">;
    const show = vi.spyOn(modelStore, "show");
    setNodeTimer("target", { expression: " 0   9 * * *  " });
    expect(held()).toEqual({ ...before, expression: "0 9 * * *" });
    expect(show).toHaveBeenCalledExactlyOnceWith({ _tag: "Edit", canvas: name, id: before.id, change: { kind: "cron", expression: "0 9 * * *" } });
    setNodeTimer("target", { expression: "0 9 * * *" });
    expect(show).toHaveBeenCalledTimes(1);
    setNodeTimer("target", undefined);
    const { expression: _gone, ...cleared } = before;
    expect(held()).toEqual(cleared);
    setNodeTimer("target", { expression: " " }); expect(show).toHaveBeenCalledTimes(2);
  });

  it("gauge changes threshold only, trims names, preserves zero, and clears absent fields", () => {
    const before = open(watcher("target", { ...place, label: "Budget", host: "studio", key: "local:builder", stat: "cost", op: "gt", value: 20 })) as NodeOf<"watcher">;
    const show = vi.spyOn(modelStore, "show");
    const watch = { key: " local:reviewer ", stat: " budget ", op: "lt" as const, value: 0 };
    setNodeWatch("target", watch);
    expect(held()).toEqual({ ...before, key: "local:reviewer", stat: "budget", op: "lt", value: 0 });
    expect(show).toHaveBeenCalledExactlyOnceWith({ _tag: "Edit", canvas: name, id: before.id, change: { kind: "watcher", key: "local:reviewer", stat: "budget", op: "lt", value: 0 } });
    setNodeWatch("target", watch); expect(show).toHaveBeenCalledTimes(1);
    setNodeWatch("target", { key: " ", op: "eq" });
    const { key: _key, stat: _stat, value: _value, ...partial } = before;
    expect(held()).toEqual({ ...partial, op: "eq" });
    setNodeWatch("target", undefined);
    const { op: _op, ...cleared } = partial;
    expect(held()).toEqual(cleared);
  });

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
      setNodeTimer(id, { expression: "0 9 * * *" });
      setNodeWatch(id, { value: 10 });
      setBoardSettings(id, { instructions: "Ship." });
    }
    expect(held()).toEqual(before); expect(show).not.toHaveBeenCalled();
  });
});
