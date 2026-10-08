// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activateNodeSurface, nodeSurfaceKind } from "../src/renderer/lib/activate-node-surface";
import { modelStore } from "../src/renderer/lib/use-model";
import { state$ } from "../src/renderer/lib/state";
import { dock$ } from "../src/renderer/lib/dock-state";
import { workDetailOpen$ } from "../src/renderer/lib/work-detail-open";
import { seat, note, region, taskBoard, terminal } from "./support/model-nodes";

const opens = vi.hoisted(() => vi.fn());
vi.mock("../src/renderer/lib/terminal-actions", () => ({ openTerminal: opens }));
const canvas = "native-surface-activation";
const oldCanvas = state$.canvasName.peek();
beforeEach(() => { state$.canvasName.set(canvas); opens.mockClear(); });
afterEach(() => {
  modelStore.canvas$(canvas).nodes.set({}); state$.canvasName.set(oldCanvas);
  workDetailOpen$.set({ nodeId: "", itemId: "" });
});
const publish = (node: ReturnType<typeof seat> | ReturnType<typeof note> | ReturnType<typeof taskBoard>) => modelStore.node$(canvas, node.id).set(node);

describe("native node surface activation", () => {
  it("opens managed seats and plain terminals, notes, and work, while regions have no surface", () => {
    expect(nodeSurfaceKind(seat("worker"))).toBe("terminal");
    expect(nodeSurfaceKind(terminal("shell"))).toBe("terminal");
    expect(nodeSurfaceKind(note("memo"))).toBe("note");
    expect(nodeSurfaceKind(region("lane", { x: 0, y: 0, width: 400, height: 300 }))).toBeNull();
  });

  it("opens the currently stored native seat by id and refuses a removed seat", () => {
    publish(seat("worker", { label: "Current", bindingId: "current-binding" as never }));
    expect(activateNodeSurface("worker")).toEqual({ opened: true, kind: "terminal" });
    expect(opens).toHaveBeenCalledOnce();
    expect(opens).toHaveBeenCalledWith(canvas, "worker");
    modelStore.node$(canvas, "worker").delete();
    expect(activateNodeSurface("worker")).toEqual({ opened: false, reason: "no-surface" });
    expect(opens).toHaveBeenCalledOnce();
  });

  it("a note opens with native text even when the document copy is empty", () => {
    publish(note("memo", "Native title\nNative content"));
    expect(activateNodeSurface("memo")).toEqual({ opened: true, kind: "note" });
    expect(Object.values(dock$.noteById.peek()).find((entry) => entry.nodeId === "memo")).toMatchObject({ title: "Native title", draft: "Native title\nNative content" });
  });

  it("a native task board opens its paged work detail by id", () => {
    publish(taskBoard("queue"));
    expect(activateNodeSurface("queue")).toEqual({ opened: true, kind: "work" });
    expect(workDetailOpen$.peek()).toEqual({ nodeId: "queue", itemId: "" });
  });
});
