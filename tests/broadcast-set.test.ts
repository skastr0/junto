import { describe, expect, it } from "vitest";
import { asCanvasName, canvasFromOpened } from "../src/shared/model";
import { readBroadcastSet } from "../src/window/lib/broadcast-set";
import { THIS_MACHINE } from "./support/machines";
import { region, seat } from "./support/model-nodes";

const canvas = canvasFromOpened({
  canvas: asCanvasName("c"),
  seq: 0,
  wires: [],
  nodes: [
    region("r", { x: 0, y: 0, width: 500, height: 300 }, { label: "Junto" }),
    seat("bound", { x: 10, y: 10, width: 100, height: 60 }),
    seat("fresh", { x: 150, y: 10, width: 100, height: 60, bindingId: undefined as never }),
  ],
});

const read = (doing: ReadonlyArray<"working" | "idle" | "off">) =>
  readBroadcastSet({
    canvasName: "c",
    canvas,
    picks: [{ kind: "region", regionId: "r", doing, needs: [] }],
    machineName: THIS_MACHINE,
    signals: [],
    eventOf: (bindingId) => (bindingId === "binding-bound" ? { state: "working" } : undefined),
    machineReadable: () => true,
  });

describe("the window's set agrees with the core's for a seat here", () => {
  it("reads a seat here with no state event as off, never unread", () => {
    const off = read(["off"]);
    expect(off.seats.map((entry) => entry.nodeId)).toEqual(["fresh"]);
    expect(off.unread).toEqual([]);
    expect(read(["working"]).seats.map((entry) => entry.nodeId)).toEqual(["bound"]);
  });
});
