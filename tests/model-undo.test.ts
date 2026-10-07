/**
 * Undo as commands: the step back from a command is worked out from the
 * canvas before it, every command undo produces is one the contract accepts,
 * and stepping back then forward lands where it started.
 */
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { asCanvasName, decodeCommand, type Command, type Node, type Wire } from "../src/shared/model";
import { canvasFromOpened, type Canvas } from "../src/shared/model/canvas";
import { canvasAfter, createEditHistory, inverseOf, stepBack } from "../src/renderer/lib/model-undo";

const name = asCanvasName("factory");

const seat = (id: string, over: Record<string, unknown> = {}): Node =>
  ({
    kind: "agent", id, x: 0, y: 0, width: 216, height: 96, z: 0,
    agentKey: `local:${id}`, label: id, host: "local", overseer: false,
    bindingId: `binding-${id}`, harness: "claude", onRemove: "detach", ...over,
  }) as unknown as Node;

const note = (id: string, over: Record<string, unknown> = {}): Node =>
  ({ kind: "note", id, x: 10, y: 20, width: 220, height: 84, z: 1, text: "hello", ...over }) as unknown as Node;

const region = (id: string, over: Record<string, unknown> = {}): Node =>
  ({ kind: "region", id, x: 0, y: 0, width: 900, height: 600, z: 2, hold: false, ...over }) as unknown as Node;

const wire = (id: string, from: string, to: string, over: Record<string, unknown> = {}): Wire =>
  ({ id, from, to, verb: "messages", ...over }) as unknown as Wire;

const canvasOf = (nodes: Node[], wires: Wire[] = []): Canvas =>
  canvasFromOpened({ canvas: name, seq: 0, nodes, wires });

const accepted = (command: Command): boolean => Exit.isSuccess(Effect.runSyncExit(decodeCommand(command)));

/** The commands that reverse one command; fails the test if there is no way back. */
const back = (canvas: Canvas, command: Command, context = {}): ReadonlyArray<Command> => {
  const inverse = inverseOf(canvas, command, context);
  if (inverse._tag !== "Reversed") throw new Error(`no way back from ${command._tag}`);
  for (const each of inverse.commands) expect(accepted(each)).toBe(true);
  return inverse.commands;
};

const run = (canvas: Canvas, commands: ReadonlyArray<Command>): Canvas =>
  commands.reduce((at, command) => canvasAfter(at, command), canvas);

/** A canvas as plain rows, to compare two of them. */
const rows = (canvas: Canvas) => ({
  nodes: [...canvas.nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
  wires: [...canvas.wires.values()].sort((a, b) => a.id.localeCompare(b.id)),
});

describe("the way back from a command", () => {
  const before = canvasOf(
    [seat("lead", { color: "3" }), seat("nodes"), note("plan"), region("room", { label: "canvas" })],
    [wire("w1", "lead", "nodes"), wire("w2", "nodes", "plan", { mask: ["msg.send"], fromSide: "right" })],
  );

  const roundTrips = (command: Command, context = {}): void => {
    const after = canvasAfter(before, command);
    expect(rows(run(after, back(before, command, context)))).toEqual(rows(before));
  };

  it("an add is removed", () => {
    const command: Command = { _tag: "Add", canvas: name, nodes: [note("new")], wires: [wire("w3", "lead", "new")] };
    expect(back(before, command)).toEqual([{ _tag: "Remove", canvas: name, nodes: ["new"], wires: ["w3"] }]);
    roundTrips(command);
  });

  it("a remove adds the nodes back with every wire that went with them", () => {
    const command: Command = { _tag: "Remove", canvas: name, nodes: ["nodes" as Node["id"]], wires: [] };
    const [add] = back(before, command);
    expect(add).toMatchObject({ _tag: "Add", canvas: name });
    if (add?._tag !== "Add") throw new Error("expected an Add");
    expect(add.nodes).toEqual([before.nodes.get("nodes" as Node["id"])]);
    expect(add.wires.map((each) => each.id).sort()).toEqual(["w1", "w2"]);
    roundTrips(command);
  });

  it("a seat comes back with its agent key, binding and session", () => {
    const canvas = canvasOf([seat("lead", { sessionId: "sess-1" })]);
    const [add] = back(canvas, { _tag: "Remove", canvas: name, nodes: ["lead" as Node["id"]], wires: [] });
    if (add?._tag !== "Add") throw new Error("expected an Add");
    expect(add.nodes[0]).toMatchObject({ agentKey: "local:lead", bindingId: "binding-lead", sessionId: "sess-1" });
  });

  it("a move goes back, and takes the old size only when the move resized", () => {
    const moved: Command = { _tag: "Move", canvas: name, moves: [{ id: "plan" as Node["id"], x: 300, y: 400 }] };
    expect(back(before, moved)).toEqual([{ _tag: "Move", canvas: name, moves: [{ id: "plan", x: 10, y: 20 }] }]);
    roundTrips(moved);
    const resized: Command = {
      _tag: "Move", canvas: name,
      moves: [{ id: "plan" as Node["id"], x: 10, y: 20, size: { width: 400, height: 300 } }],
    };
    expect(back(before, resized)).toEqual([
      { _tag: "Move", canvas: name, moves: [{ id: "plan", x: 10, y: 20, size: { width: 220, height: 84 } }] },
    ]);
    roundTrips(resized);
  });

  it("a recolour goes back to each colour the nodes had, and to none", () => {
    const command: Command = {
      _tag: "Recolor", canvas: name, nodes: ["lead", "nodes", "plan"] as Array<Node["id"]>, color: "5",
    };
    expect(back(before, command)).toEqual([
      { _tag: "Recolor", canvas: name, nodes: ["lead"], color: "3" },
      { _tag: "Recolor", canvas: name, nodes: ["nodes", "plan"], color: null },
    ]);
    roundTrips(command);
  });

  it("an edit goes back to the old values, clearing a field that was absent", () => {
    const rename: Command = { _tag: "Edit", canvas: name, id: "lead" as Node["id"], change: { kind: "agent", label: "captain" } };
    expect(back(before, rename)).toEqual([
      { _tag: "Edit", canvas: name, id: "lead", change: { kind: "agent", label: "lead" } },
    ]);
    roundTrips(rename);
    const brief: Command = {
      _tag: "Edit", canvas: name, id: "room" as Node["id"],
      change: { kind: "region", label: null, hold: true, instruction: "read the brief" },
    };
    expect(back(before, brief)).toEqual([
      { _tag: "Edit", canvas: name, id: "room", change: { kind: "region", label: "canvas", hold: false, instruction: null } },
    ]);
    roundTrips(brief);
  });

  it("a rewire goes back to the old verb, mask and sides", () => {
    const command: Command = {
      _tag: "Rewire", canvas: name, id: "w2" as Wire["id"],
      change: { verb: "reviews", mask: null, fromSide: "top", toSide: "left" },
    };
    expect(back(before, command)).toEqual([
      { _tag: "Rewire", canvas: name, id: "w2", change: { verb: "messages", mask: ["msg.send"], fromSide: "right", toSide: null } },
    ]);
    roundTrips(command);
  });

  it("a sheet write goes back to the grid it replaced, when that grid is known", () => {
    const grid = { columns: [], rows: [] };
    const command: Command = { _tag: "WriteSheet", canvas: name, id: "plan" as Node["id"], grid };
    expect(inverseOf(before, command)).toEqual({ _tag: "Irreversible", why: "missing" });
    expect(back(before, command, { sheetOf: () => grid })).toEqual([command]);
  });

  it("a command on something that is not there reverses to nothing", () => {
    expect(back(before, { _tag: "Move", canvas: name, moves: [{ id: "gone" as Node["id"], x: 1, y: 1 }] })).toEqual([]);
    expect(back(before, { _tag: "Edit", canvas: name, id: "lead" as Node["id"], change: { kind: "note", text: "x" } })).toEqual([]);
    expect(back(before, { _tag: "Remove", canvas: name, nodes: ["gone" as Node["id"]], wires: [] })).toEqual([]);
  });
});

describe("authority is never part of undo", () => {
  it("has no way back from a grant, a session record or a whole canvas", () => {
    const canvas = canvasOf([seat("lead")]);
    const never: Command[] = [
      { _tag: "GrantOverseer", canvas: name, id: "lead" as Node["id"], overseer: true },
      { _tag: "RecordSession", canvas: name, id: "lead" as Node["id"], sessionId: "s" },
      { _tag: "CreateCanvas", canvas: name },
      { _tag: "RemoveCanvas", canvas: name },
      { _tag: "RenameCanvas", canvas: name, to: asCanvasName("works") },
    ];
    for (const command of never) expect(inverseOf(canvas, command)).toEqual({ _tag: "Irreversible", why: "never" });
  });

  it("puts a removed overseer back without the grant", () => {
    const canvas = canvasOf([seat("lead", { overseer: true })]);
    const [add] = back(canvas, { _tag: "Remove", canvas: name, nodes: ["lead" as Node["id"]], wires: [] });
    if (add?._tag !== "Add") throw new Error("expected an Add");
    expect(add.nodes[0]).toMatchObject({ kind: "agent", overseer: false });
  });

  it("never produces a grant, whatever is undone and redone", () => {
    const history = createEditHistory();
    let canvas = canvasOf([seat("lead", { overseer: true }), note("plan")]);
    const sent: Command[] = [];
    const act = (commands: Command[]): void => {
      history.record(canvas, commands);
      canvas = run(canvas, commands);
    };
    act([{ _tag: "GrantOverseer", canvas: name, id: "lead" as Node["id"], overseer: false }]);
    act([{ _tag: "Remove", canvas: name, nodes: ["lead" as Node["id"]], wires: [] }]);
    act([{ _tag: "Edit", canvas: name, id: "plan" as Node["id"], change: { kind: "note", text: "x" } }]);
    for (let i = 0; i < 4; i += 1) {
      const step = history.undo(canvas);
      sent.push(...step);
      canvas = run(canvas, step);
    }
    for (let i = 0; i < 4; i += 1) {
      const step = history.redo(canvas);
      sent.push(...step);
      canvas = run(canvas, step);
    }
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.some((command) => command._tag === "GrantOverseer")).toBe(false);
    for (const command of sent) {
      if (command._tag !== "Add") continue;
      for (const node of command.nodes) if (node.kind === "agent") expect(node.overseer).toBe(false);
    }
  });
});

describe("a step of several commands", () => {
  it("is taken back last first, each against the canvas as it stood", () => {
    const before = canvasOf([note("plan")]);
    const commands: Command[] = [
      { _tag: "Move", canvas: name, moves: [{ id: "plan" as Node["id"], x: 100, y: 100 }] },
      { _tag: "Move", canvas: name, moves: [{ id: "plan" as Node["id"], x: 200, y: 200 }] },
      { _tag: "Add", canvas: name, nodes: [note("extra")], wires: [] },
    ];
    const { back: step, skipped } = stepBack(before, commands);
    expect(skipped).toEqual([]);
    expect(step).toEqual([
      { _tag: "Remove", canvas: name, nodes: ["extra"], wires: [] },
      { _tag: "Move", canvas: name, moves: [{ id: "plan", x: 100, y: 100 }] },
      { _tag: "Move", canvas: name, moves: [{ id: "plan", x: 10, y: 20 }] },
    ]);
    expect(rows(run(run(before, commands), step))).toEqual(rows(before));
  });

  it("names what it could not take back and still takes back the rest", () => {
    const before = canvasOf([note("plan"), note("other")]);
    const restack: Command = { _tag: "Restack", canvas: name, nodes: ["plan" as Node["id"]], to: "front" };
    const move: Command = { _tag: "Move", canvas: name, moves: [{ id: "plan" as Node["id"], x: 1, y: 2 }] };
    const { back: step, skipped } = stepBack(before, [restack, move]);
    expect(skipped).toEqual([restack]);
    expect(step).toEqual([{ _tag: "Move", canvas: name, moves: [{ id: "plan", x: 10, y: 20 }] }]);
  });
});

describe("the undo stack", () => {
  it("walks back and forward through what was done", () => {
    const history = createEditHistory();
    const start = canvasOf([note("plan")]);
    let canvas = start;
    const act = (commands: Command[]): void => {
      history.record(canvas, commands);
      canvas = run(canvas, commands);
    };
    act([{ _tag: "Edit", canvas: name, id: "plan" as Node["id"], change: { kind: "note", text: "one" } }]);
    const one = canvas;
    act([{ _tag: "Move", canvas: name, moves: [{ id: "plan" as Node["id"], x: 500, y: 500 }] }]);
    const two = canvas;

    expect(history.canUndo()).toBe(true);
    expect(history.canRedo()).toBe(false);
    canvas = run(canvas, history.undo(canvas));
    expect(rows(canvas)).toEqual(rows(one));
    canvas = run(canvas, history.undo(canvas));
    expect(rows(canvas)).toEqual(rows(start));
    expect(history.canUndo()).toBe(false);
    expect(history.undo(canvas)).toEqual([]);

    canvas = run(canvas, history.redo(canvas));
    expect(rows(canvas)).toEqual(rows(one));
    canvas = run(canvas, history.redo(canvas));
    expect(rows(canvas)).toEqual(rows(two));
    expect(history.canRedo()).toBe(false);
  });

  it("drops redo when something new is done, and keeps no more steps than its limit", () => {
    const history = createEditHistory(2);
    let canvas = canvasOf([note("plan")]);
    const move = (x: number): void => {
      const commands: Command[] = [{ _tag: "Move", canvas: name, moves: [{ id: "plan" as Node["id"], x, y: 0 }] }];
      history.record(canvas, commands);
      canvas = run(canvas, commands);
    };
    move(1);
    move(2);
    canvas = run(canvas, history.undo(canvas));
    expect(history.canRedo()).toBe(true);
    move(3);
    expect(history.canRedo()).toBe(false);
    move(4);
    move(5);
    canvas = run(canvas, history.undo(canvas));
    canvas = run(canvas, history.undo(canvas));
    expect(history.canUndo()).toBe(false);
    expect(canvas.nodes.get("plan" as Node["id"])?.x).toBe(3);
  });

  it("does not note an act that has no way back", () => {
    const history = createEditHistory();
    const canvas = canvasOf([seat("lead")]);
    history.record(canvas, [{ _tag: "GrantOverseer", canvas: name, id: "lead" as Node["id"], overseer: true }]);
    expect(history.canUndo()).toBe(false);
  });
});
