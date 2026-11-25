import { describe, expect, it } from "vitest";
import { asCanvasName, canvasFromOpened } from "../src/shared/model";
import { readBroadcastSet } from "../src/window/lib/broadcast-set";
import { OTHER_MACHINE, THIS_MACHINE } from "./support/machines";
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

const read = (doing: ReadonlyArray<"working" | "idle" | "off">, eventOf: Parameters<typeof readBroadcastSet>[0]["eventOf"] = (bindingId) => (bindingId === "binding-bound" ? { state: "working" } : undefined)) =>
  readBroadcastSet({
    canvasName: "c",
    canvas,
    picks: [{ kind: "region", regionId: "r", doing, needs: [] }],
    machineName: THIS_MACHINE,
    signals: [],
    eventOf,
  });

describe("the window's set agrees with the core's for a seat here", () => {
  it("reads a seat here with no state event as off, never unread", () => {
    const off = read(["off"]);
    expect(off.seats.map((entry) => entry.nodeId)).toEqual(["fresh"]);
    expect(off.unread).toEqual([]);
    expect(read(["working"]).seats.map((entry) => entry.nodeId)).toEqual(["bound"]);
  });
});

describe("a seat of another machine is current only as main serves it", () => {
  const remote = canvasFromOpened({
    canvas: asCanvasName("c"),
    seq: 0,
    wires: [],
    nodes: [
      region("r", { x: 0, y: 0, width: 500, height: 300 }, { label: "Junto" }),
      seat("far", { x: 10, y: 10, width: 100, height: 60, host: OTHER_MACHINE }),
    ],
  });
  const readRemote = (event: { state: "working" | "idle"; current?: boolean } | undefined) =>
    readBroadcastSet({
      canvasName: "c",
      canvas: remote,
      picks: [{ kind: "region", regionId: "r", doing: ["working"], needs: [] }],
      machineName: THIS_MACHINE,
      signals: [],
      eventOf: () => event,
    });

  it("holds it under a doing limit when its link has held, as the core does", () => {
    const set = readRemote({ state: "working", current: true });
    expect(set.seats.map((entry) => entry.nodeId)).toEqual(["far"]);
    expect(set.unread).toEqual([]);
  });
  it("leaves it out as unread after a lost link or with no flag, whatever else is known", () => {
    for (const event of [{ state: "working" as const, current: false }, { state: "working" as const }, undefined]) {
      const set = readRemote(event);
      expect(set.seats).toEqual([]);
      expect(set.unread.map((entry) => entry.nodeId)).toEqual(["far"]);
    }
  });
});
