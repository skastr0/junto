/**
 * Every edit the operator can make, as commands: each is one the contract
 * accepts, an edit that changes nothing sends nothing, and what is sent says
 * all it touches.
 */
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { PAD_ENABLED, TASKS_ENABLED } from "../src/shared/features";
import { asCanvasName, decodeCommand, type Command, type Node, type Wire } from "../src/shared/model";
import { canvasFromOpened, type Canvas } from "../src/shared/model/canvas";
import {
  added,
  connected,
  edited,
  heldBy,
  masked,
  moved,
  reanchored,
  recolored,
  regionDragged,
  regionEdited,
  removed,
  renamed,
  resized,
  restacked,
  retexted,
  reverbed,
  sheetWritten,
  taskBoardEdited,
  topZ,
  verbsForDraw,
} from "../src/renderer/lib/model-edits";
import { canvasAfter, stepBack } from "../src/renderer/lib/model-undo";

const name = asCanvasName("factory");
const place = { x: 0, y: 0, width: 216, height: 96 };

const node = (kind: string, id: string, over: Record<string, unknown> = {}): Node =>
  ({ kind, id, ...place, z: 0, ...over }) as unknown as Node;

const seat = (id: string, over: Record<string, unknown> = {}): Node =>
  node("agent", id, {
    agentKey: `local:${id}`, label: id, host: "local", overseer: false,
    bindingId: `binding-${id}`, harness: "claude", onRemove: "detach", ...over,
  });
const board = (id: string, over: Record<string, unknown> = {}): Node => node("task", id, over);
const note = (id: string, over: Record<string, unknown> = {}): Node => node("note", id, { text: "hello", ...over });
const region = (id: string, over: Record<string, unknown> = {}): Node => node("region", id, { hold: false, ...over });

const wire = (id: string, from: string, to: string, over: Record<string, unknown> = {}): Wire =>
  ({ id, from, to, verb: "messages", ...over }) as unknown as Wire;

const canvasOf = (nodes: Node[], wires: Wire[] = []): Canvas => canvasFromOpened({ canvas: name, seq: 0, nodes, wires });

/** The commands, each checked against the contract. */
const sent = (commands: ReadonlyArray<Command>): ReadonlyArray<Command> => {
  for (const command of commands) {
    const exit = Effect.runSyncExit(decodeCommand(command));
    if (!Exit.isSuccess(exit)) throw new Error(`the contract refuses ${JSON.stringify(command)}`);
  }
  return commands;
};

describe("renaming", () => {
  const canvas = canvasOf([
    seat("lead"), board("tasks", { name: "Backlog" }), node("terminal", "term", { host: "local", bindingId: "b", onRemove: "detach", label: "shell" }),
    region("room", { label: "canvas" }), note("plan"), node("label", "north", { text: "North" }),
  ]);

  it("writes the name to the field each kind keeps it in", () => {
    expect(sent(renamed(canvas, "lead", "captain"))).toEqual([
      { _tag: "Edit", canvas: name, id: "lead", change: { kind: "agent", label: "captain" } },
    ]);
    expect(sent(renamed(canvas, "tasks", "Sprint"))).toEqual([
      { _tag: "Edit", canvas: name, id: "tasks", change: { kind: "task", name: "Sprint" } },
    ]);
    expect(sent(renamed(canvas, "room", "window"))).toEqual([
      { _tag: "Edit", canvas: name, id: "room", change: { kind: "region", label: "window" } },
    ]);
  });

  it("keeps one line, trimmed", () => {
    expect(sent(renamed(canvas, "term", "  build \nsecond line"))).toEqual([
      { _tag: "Edit", canvas: name, id: "term", change: { kind: "terminal", label: "build" } },
    ]);
  });

  it("clears an empty name, except a seat's, which always has one", () => {
    expect(sent(renamed(canvas, "term", "  "))).toEqual([
      { _tag: "Edit", canvas: name, id: "term", change: { kind: "terminal", label: null } },
    ]);
    expect(renamed(canvas, "lead", "")).toEqual([]);
  });

  it("sends nothing for the name it already has, or for a kind with no name", () => {
    expect(renamed(canvas, "lead", "lead")).toEqual([]);
    expect(renamed(canvas, "plan", "anything")).toEqual([]);
    expect(renamed(canvas, "gone", "anything")).toEqual([]);
  });

  it("replaces the text of a note or a label, whole", () => {
    expect(sent(retexted(canvas, "plan", "# Plan\nsecond line"))).toEqual([
      { _tag: "Edit", canvas: name, id: "plan", change: { kind: "note", text: "# Plan\nsecond line" } },
    ]);
    expect(sent(retexted(canvas, "north", "South"))).toEqual([
      { _tag: "Edit", canvas: name, id: "north", change: { kind: "label", text: "South" } },
    ]);
    expect(retexted(canvas, "plan", "hello")).toEqual([]);
    expect(retexted(canvas, "lead", "text")).toEqual([]);
  });
});

describe("editing fields", () => {
  const canvas = canvasOf([region("room", { label: "canvas", instruction: "read the brief" }), board("tasks")]);

  it("names only the fields that change, and clears with null", () => {
    expect(sent(regionEdited(canvas, "room", { hold: true, instruction: null, label: "canvas" }))).toEqual([
      { _tag: "Edit", canvas: name, id: "room", change: { kind: "region", hold: true, instruction: null } },
    ]);
  });

  it("sends nothing when nothing changes, when clearing what is absent, or for another kind", () => {
    expect(regionEdited(canvas, "room", { hold: false, instruction: "read the brief" })).toEqual([]);
    expect(regionEdited(canvas, "room", { defaults: null, contract: null })).toEqual([]);
    expect(edited(canvas, "room", "task", { name: "x" })).toEqual([]);
  });

  it("edits a task board's name and contract", () => {
    const contract = { instructions: "Ship it." };
    expect(sent(taskBoardEdited(canvas, "tasks", { name: "Backlog", contract }))).toEqual([
      { _tag: "Edit", canvas: name, id: "tasks", change: { kind: "task", name: "Backlog", contract } },
    ]);
  });
});

describe("moving and resizing", () => {
  const canvas = canvasOf([
    note("a", { x: 10, y: 10 }), note("b", { x: 500, y: 500 }),
    region("room", { x: 0, y: 0, width: 400, height: 400, hold: true }),
    region("loose", { x: 1000, y: 0, width: 400, height: 400 }),
    note("straddle", { x: 300, y: 300, width: 190, height: 190 }),
  ]);

  it("moves a selection in one command, whole numbers, and leaves out what did not move", () => {
    const positions = new Map([["a", { x: 20.4, y: 30.6 }], ["b", { x: 500, y: 500 }], ["gone", { x: 1, y: 1 }]]);
    expect(sent(moved(canvas, positions))).toEqual([
      { _tag: "Move", canvas: name, moves: [{ id: "a", x: 20, y: 31 }] },
    ]);
    expect(moved(canvas, new Map([["b", { x: 500.2, y: 499.8 }]]))).toEqual([]);
  });

  it("resizes with the size, and only moves when the size is the same", () => {
    expect(sent(resized(canvas, "a", { x: 10, y: 10, width: 300, height: 200 }))).toEqual([
      { _tag: "Move", canvas: name, moves: [{ id: "a", x: 10, y: 10, size: { width: 300, height: 200 } }] },
    ]);
    expect(sent(resized(canvas, "a", { x: 5, y: 10, width: 216, height: 96 }))).toEqual([
      { _tag: "Move", canvas: name, moves: [{ id: "a", x: 5, y: 10 }] },
    ]);
    expect(resized(canvas, "a", { x: 10, y: 10, width: 216, height: 96 })).toEqual([]);
    expect(resized(canvas, "a", { x: 10, y: 10, width: 0, height: 96 })).toEqual([]);
  });

  it("a holding region carries what has its centre inside, a loose one carries nothing", () => {
    expect([...heldBy(canvas, "room")].sort()).toEqual(["a", "straddle"]);
    expect(heldBy(canvas, "loose")).toEqual([]);
    const [move] = sent(regionDragged(canvas, "room", { x: 100, y: 50 }));
    if (move?._tag !== "Move") throw new Error("expected a Move");
    expect([...move.moves].sort((x, y) => x.id.localeCompare(y.id))).toEqual([
      { id: "a", x: 110, y: 60 },
      { id: "room", x: 100, y: 50 },
      { id: "straddle", x: 400, y: 350 },
    ]);
    expect(sent(regionDragged(canvas, "loose", { x: 1100, y: 0 }))).toEqual([
      { _tag: "Move", canvas: name, moves: [{ id: "loose", x: 1100, y: 0 }] },
    ]);
  });

  it("a region drag is one step back", () => {
    const commands = regionDragged(canvas, "room", { x: 100, y: 50 });
    const after = commands.reduce(canvasAfter, canvas);
    const { back } = stepBack(canvas, commands);
    expect(back).toHaveLength(1);
    expect([...back.reduce(canvasAfter, after).nodes.values()]).toEqual([...canvas.nodes.values()]);
  });
});

describe("colour and order", () => {
  const canvas = canvasOf([note("a", { z: 0, color: "3" }), note("b", { z: 5 }), note("c", { z: 9 })]);

  it("recolours only the nodes not already that colour", () => {
    expect(sent(recolored(canvas, ["a", "b", "b"], "3"))).toEqual([
      { _tag: "Recolor", canvas: name, nodes: ["b"], color: "3" },
    ]);
    expect(sent(recolored(canvas, ["a", "b"], undefined))).toEqual([
      { _tag: "Recolor", canvas: name, nodes: ["a"], color: null },
    ]);
    expect(recolored(canvas, ["a"], "3")).toEqual([]);
  });

  it("restacks in the order the nodes already stack, and not when they are already there", () => {
    expect(sent(restacked(canvas, ["b", "a"], "front"))).toEqual([
      { _tag: "Restack", canvas: name, nodes: ["a", "b"], to: "front" },
    ]);
    expect(restacked(canvas, ["c"], "front")).toEqual([]);
    expect(restacked(canvas, ["b", "a"], "back")).toEqual([]);
    expect(restacked(canvas, ["gone"], "back")).toEqual([]);
  });

  it("a new node stacks above everything, whatever the gaps", () => {
    expect(topZ(canvas)).toBe(10);
    expect(topZ(canvasOf([]))).toBe(0);
  });
});

describe("adding and removing", () => {
  const canvas = canvasOf(
    [seat("lead"), seat("nodes"), board("tasks")],
    [wire("w1", "lead", "nodes"), wire("w2", "nodes", "tasks", { verb: "works" }), wire("w3", "lead", "tasks", { verb: "works" })],
  );

  it("adds nodes and wires in one command", () => {
    const extra = note("extra", { z: topZ(canvas) });
    expect(sent(added(canvas, [extra]))).toEqual([{ _tag: "Add", canvas: name, nodes: [extra], wires: [] }]);
    expect(added(canvas, [])).toEqual([]);
  });

  it("names every wire at a removed node's ends", () => {
    const [remove] = sent(removed(canvas, ["nodes", "nodes", "gone"]));
    if (remove?._tag !== "Remove") throw new Error("expected a Remove");
    expect(remove.nodes).toEqual(["nodes"]);
    expect([...remove.wires].sort()).toEqual(["w1", "w2"]);
  });

  it("removes a wire alone, and sends nothing for what is not there", () => {
    expect(sent(removed(canvas, [], ["w3"]))).toEqual([{ _tag: "Remove", canvas: name, nodes: [], wires: ["w3"] }]);
    expect(removed(canvas, ["gone"], ["nope"])).toEqual([]);
  });

  it("a removal steps back to the same canvas", () => {
    const commands = removed(canvas, ["nodes"]);
    const after = commands.reduce(canvasAfter, canvas);
    expect(after.nodes.size).toBe(2);
    expect(after.wires.size).toBe(1);
    const { back } = stepBack(canvas, commands);
    const again = back.reduce(canvasAfter, after);
    expect(new Map(again.nodes)).toEqual(new Map(canvas.nodes));
    expect([...again.wires.keys()].sort()).toEqual(["w1", "w2", "w3"]);
  });
});

describe("wires", () => {
  const canvas = canvasOf(
    [seat("lead"), seat("nodes"), board("tasks"), board("done"), node("pad", "pad"), node("label", "north", { text: "N" }), region("room"), note("plan")],
    [wire("w1", "lead", "nodes")],
  );
  const at = (id: string): Node => canvas.nodes.get(id as Node["id"])!;

  it("joins two seats with the pair's default verb", () => {
    const result = connected(canvas, { id: "w9", from: "nodes", to: "lead" });
    if (!result.ok) throw new Error(result.why);
    sent(result.commands);
    expect(result.wire).toEqual({ id: "w9", from: "nodes", to: "lead", verb: verbsForDraw(at("nodes"), at("lead")).verbs[0] });
    expect(result.commands).toEqual([{ _tag: "Add", canvas: name, nodes: [], wires: [result.wire] }]);
  });

  it.skipIf(!PAD_ENABLED)("stores the wire the way the verb reads, and keeps the anchors with their ends", () => {
    // A seat reads a pad; nothing runs from a pad to a seat.
    const forward = verbsForDraw(at("lead"), at("pad"));
    expect(forward.verbs.length).toBeGreaterThan(0);
    expect(forward.reversed).toBe(false);
    expect(verbsForDraw(at("pad"), at("lead"))).toEqual({ verbs: forward.verbs, reversed: true });
    const result = connected(canvas, { id: "w9", from: "pad", to: "lead", fromSide: "left", toSide: "right" });
    if (!result.ok) throw new Error(result.why);
    sent(result.commands);
    expect(result.wire).toMatchObject({ from: "lead", to: "pad", fromSide: "right", toSide: "left" });
  });

  it("takes the verb the operator dropped on only when the pair admits it", () => {
    const admitted = verbsForDraw(at("lead"), at("nodes")).verbs;
    const picked = admitted[admitted.length - 1]!;
    const fresh = canvasOf([seat("lead"), seat("nodes")]);
    const result = connected(fresh, { id: "w9", from: "lead", to: "nodes", verb: picked });
    expect(result.ok && result.wire.verb).toBe(picked);
    const wrong = connected(fresh, { id: "w9", from: "lead", to: "nodes", verb: "feeds" });
    expect(wrong.ok && wrong.wire.verb).toBe(admitted[0]);
  });

  it("refuses a wire to itself, to nothing, to a label, between cards that cannot be joined, and a second one", () => {
    const why = (from: string, to: string) => {
      const result = connected(canvas, { id: "w9", from, to });
      return result.ok ? "ok" : result.why;
    };
    expect(why("lead", "lead")).toBe("self");
    expect(why("lead", "gone")).toBe("missing");
    expect(why("lead", "north")).toBe("label");
    expect(why("lead", "room")).toBe("no-verb");
    expect(why("plan", "room")).toBe("no-verb");
    expect(why("lead", "nodes")).toBe("duplicate");
  });

  it.skipIf(!TASKS_ENABLED)("refuses a feed that would close a loop", () => {
    const looped = canvasOf([board("tasks"), board("done")], [wire("f1", "tasks", "done", { verb: "feeds" })]);
    const result = connected(looped, { id: "f2", from: "done", to: "tasks", verb: "feeds" });
    expect(result).toMatchObject({ ok: false, why: "cycle" });
  });

  it("changes a verb only to one the ends admit, and gives the masked ports back", () => {
    const admitted = verbsForDraw(at("lead"), at("nodes")).verbs;
    const other = admitted.find((verb) => verb !== "messages");
    const masks = canvasOf([seat("lead"), seat("nodes")], [wire("w1", "lead", "nodes", { mask: ["msg.send"] })]);
    if (other !== undefined) {
      expect(sent(reverbed(masks, "w1", other))).toEqual([
        { _tag: "Rewire", canvas: name, id: "w1", change: { verb: other, mask: null } },
      ]);
    }
    expect(reverbed(masks, "w1", "messages")).toEqual([]);
    expect(reverbed(masks, "w1", "feeds")).toEqual([]);
    expect(reverbed(masks, "gone", "messages")).toEqual([]);
  });

  it("masks ports, gives them back, and moves an anchor", () => {
    expect(sent(masked(canvas, "w1", ["msg.send"]))).toEqual([
      { _tag: "Rewire", canvas: name, id: "w1", change: { mask: ["msg.send"] } },
    ]);
    expect(masked(canvas, "w1", undefined)).toEqual([]);
    const held = canvasOf([seat("lead"), seat("nodes")], [wire("w1", "lead", "nodes", { mask: ["msg.send"], fromSide: "top" })]);
    expect(sent(masked(held, "w1", undefined))).toEqual([
      { _tag: "Rewire", canvas: name, id: "w1", change: { mask: null } },
    ]);
    expect(masked(held, "w1", ["msg.send"])).toEqual([]);
    expect(sent(reanchored(held, "w1", { fromSide: null, toSide: "left" }))).toEqual([
      { _tag: "Rewire", canvas: name, id: "w1", change: { fromSide: null, toSide: "left" } },
    ]);
  });
});

describe("sheets", () => {
  const canvas = canvasOf([node("sheet", "grid"), note("plan")]);
  const grid = { columns: [], rows: [] };

  it("writes a sheet's grid, and not when it is the grid it has", () => {
    expect(sent(sheetWritten(canvas, "grid", grid))).toEqual([{ _tag: "WriteSheet", canvas: name, id: "grid", grid }]);
    expect(sheetWritten(canvas, "grid", grid, { columns: [], rows: [] })).toEqual([]);
    expect(sheetWritten(canvas, "plan", grid)).toEqual([]);
  });
});
