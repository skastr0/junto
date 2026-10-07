/**
 * The difference between two documents as commands: sending them takes the
 * canvas from the first to the second, every one is a command the contract
 * accepts, and what a document cannot decide is never sent.
 */
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasEdge, CanvasNode } from "../src/shared/canvas";
import { decodeCommand, type Command, type Node } from "../src/shared/model";
import type { Canvas } from "../src/shared/model/canvas";
import { canvasFromDocument } from "../src/shared/model/from-document";
import { documentEdits } from "../src/renderer/lib/document-edits";
import { canvasAfter } from "../src/renderer/lib/model-undo";

const rect = (x: number, y: number, width = 220, height = 84) => ({ x, y, width, height });

const note = (id: string, text: string, at = rect(0, 0)): CanvasNode => ({ id, type: "text", text, ...at }) as CanvasNode;
const seat = (id: string, over: Record<string, unknown> = {}, terminal: Record<string, unknown> = {}): CanvasNode =>
  ({
    id, type: "text", text: id, ...rect(0, 0, 216, 56),
    ether: {
      entity: { kind: "agent", name: `local:claude` }, host: "local",
      terminal: { bindingId: `binding-${id}`, harness: "claude", ...terminal },
      ...over,
    },
  }) as CanvasNode;
const board = (id: string, tasks: Record<string, unknown> = { items: [] }): CanvasNode =>
  ({ id, type: "text", text: "tasks", ...rect(0, 300, 240, 120), ether: { entity: { kind: "task" }, tasks } }) as CanvasNode;
const region = (id: string, label: string, over: Record<string, unknown> = {}): CanvasNode =>
  ({ id, type: "group", label, ...rect(0, 0, 900, 600), ...over }) as CanvasNode;
const edge = (id: string, fromNode: string, toNode: string, ether: Record<string, unknown> = { verb: "messages" }): CanvasEdge =>
  ({ id, fromNode, toNode, ether }) as CanvasEdge;

const doc = (nodes: CanvasNode[], edges: CanvasEdge[] = []): CanvasDoc => ({ nodes, edges });

const sent = (before: CanvasDoc, after: CanvasDoc): ReadonlyArray<Command> => {
  const commands = documentEdits("factory", before, after, 100);
  for (const command of commands) {
    const exit = Effect.runSyncExit(decodeCommand(command));
    if (!Exit.isSuccess(exit)) throw new Error(`the contract refuses ${JSON.stringify(command)}`);
  }
  return commands;
};

/** A canvas as rows, without where each node stacks or whether it oversees. */
const shape = (canvas: Canvas) => ({
  nodes: [...canvas.nodes.values()]
    .map((node) => {
      const { z: _z, ...rest } = node as Node & { overseer?: boolean; sessionId?: string };
      delete rest.overseer;
      delete rest.sessionId;
      return rest;
    })
    .sort((a, b) => a.id.localeCompare(b.id)),
  wires: [...canvas.wires.values()].sort((a, b) => a.id.localeCompare(b.id)),
});

/** Sending the difference takes the first canvas to the second. */
const arrives = (before: CanvasDoc, after: CanvasDoc): ReadonlyArray<Command> => {
  const commands = sent(before, after);
  const reached = commands.reduce(canvasAfter, canvasFromDocument("factory", before));
  expect(shape(reached)).toEqual(shape(canvasFromDocument("factory", after)));
  return commands;
};

describe("the difference between two documents", () => {
  const base = doc(
    [region("room", "canvas"), seat("lead"), seat("nodes"), note("plan", "hello"), board("tasks")],
    [edge("w1", "lead", "nodes"), edge("w2", "lead", "tasks", { verb: "manages" })],
  );
  const change = (id: string, with_: (node: CanvasNode) => CanvasNode): CanvasDoc =>
    doc(base.nodes.map((node) => (node.id === id ? with_(node) : node)), [...base.edges]);

  it("is nothing when the documents say the same", () => {
    expect(sent(base, base)).toEqual([]);
    expect(sent(base, doc([...base.nodes], [...base.edges]))).toEqual([]);
  });

  it("is a move, with the size only when it changed", () => {
    expect(arrives(base, change("plan", (node) => ({ ...node, x: 50, y: 60 })))).toEqual([
      { _tag: "Move", canvas: "factory", moves: [{ id: "plan", x: 50, y: 60 }] },
    ]);
    expect(arrives(base, change("plan", (node) => ({ ...node, width: 400 })))).toEqual([
      { _tag: "Move", canvas: "factory", moves: [{ id: "plan", x: 0, y: 0, size: { width: 400, height: 84 } }] },
    ]);
  });

  it("is one move for a drag of several", () => {
    const after = doc(base.nodes.map((node) => (node.type === "text" ? { ...node, x: node.x + 10 } : node)), [...base.edges]);
    const commands = arrives(base, after);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ _tag: "Move" });
  });

  it("is an edit of the field the kind keeps it in", () => {
    expect(arrives(base, change("plan", (node) => ({ ...node, text: "bye" } as CanvasNode)))).toEqual([
      { _tag: "Edit", canvas: "factory", id: "plan", change: { kind: "note", text: "bye" } },
    ]);
    expect(arrives(base, change("lead", (node) => ({ ...node, text: "captain" } as CanvasNode)))).toEqual([
      { _tag: "Edit", canvas: "factory", id: "lead", change: { kind: "agent", label: "captain" } },
    ]);
    expect(arrives(base, change("room", (node) => ({ ...node, label: "", ether: { region: { hold: true } } } as CanvasNode)))).toEqual([
      { _tag: "Edit", canvas: "factory", id: "room", change: { kind: "region", label: "", hold: true } },
    ]);
  });

  it("is a recolour, and a clearing of one", () => {
    const coloured = change("plan", (node) => ({ ...node, color: "3" }));
    expect(arrives(base, coloured)).toEqual([{ _tag: "Recolor", canvas: "factory", nodes: ["plan"], color: "3" }]);
    expect(arrives(coloured, base)).toEqual([{ _tag: "Recolor", canvas: "factory", nodes: ["plan"], color: null }]);
  });

  it("adds a node above what is there, with the wires drawn to it", () => {
    const after = doc([...base.nodes, note("extra", "new")], [...base.edges, edge("w3", "lead", "extra")]);
    const [add] = arrives(base, after);
    if (add?._tag !== "Add") throw new Error("expected an Add");
    expect(add.nodes).toHaveLength(1);
    expect(add.nodes[0]).toMatchObject({ id: "extra", kind: "note", z: 100 });
    expect(add.wires.map((wire) => wire.id)).toEqual(["w3"]);
  });

  it("removes a node with the wires at its ends, and a wire alone", () => {
    const after = doc(base.nodes.filter((node) => node.id !== "lead"), []);
    expect(arrives(base, after)).toEqual([{ _tag: "Remove", canvas: "factory", nodes: ["lead"], wires: ["w1", "w2"] }]);
    expect(arrives(base, doc([...base.nodes], [base.edges[0]!]))).toEqual([
      { _tag: "Remove", canvas: "factory", nodes: [], wires: ["w2"] },
    ]);
  });

  it("rewires a verb, a mask and a side, and replaces a wire whose ends changed", () => {
    const reverbed = doc([...base.nodes], [edge("w1", "lead", "nodes", { verb: "reviews", mask: ["msg.send"] }), base.edges[1]!]);
    expect(arrives(base, reverbed)).toEqual([
      { _tag: "Rewire", canvas: "factory", id: "w1", change: { verb: "reviews", mask: ["msg.send"] } },
    ]);
    const turned = doc([...base.nodes], [edge("w1", "nodes", "lead"), base.edges[1]!]);
    const commands = arrives(base, turned);
    expect(commands.map((command) => command._tag)).toEqual(["Remove", "Add"]);
  });

  it("is a reseat when another agent or a new session takes the seat", () => {
    const after = change("lead", () =>
      seat("lead", { entity: { kind: "agent", name: "local:codex" } }, { bindingId: "binding-new", harness: "codex" }),
    );
    expect(arrives(base, after)).toEqual([{
      _tag: "Reseat", canvas: "factory", id: "lead", agentKey: "local:codex", bindingId: "binding-new",
      harness: "codex", host: "local", launch: null,
    }]);
  });

  it("writes a sheet's grid by its own command", () => {
    const sheet = (grid: unknown): CanvasNode =>
      ({ id: "grid", type: "text", text: "sheet", ...rect(0, 0, 260, 120), ether: { entity: { kind: "sheet" }, sheet: grid } }) as CanvasNode;
    const empty = { columns: [], rows: [] };
    const filled = { columns: [{ id: "c1", name: "Name" }], rows: [] };
    const commands = documentEdits("factory", doc([sheet(empty)]), doc([sheet(filled)]), 0);
    expect(commands).toEqual([{ _tag: "WriteSheet", canvas: "factory", id: "grid", grid: filled }]);
    expect(documentEdits("factory", doc([sheet(empty)]), doc([sheet({ columns: [], rows: [] })]), 0)).toEqual([]);
  });

  it("restacks when the order of the nodes both hold changed, and not when one was only added or removed", () => {
    const swapped = doc([base.nodes[0]!, base.nodes[2]!, base.nodes[1]!, base.nodes[3]!, base.nodes[4]!], [...base.edges]);
    expect(sent(base, swapped)).toEqual([
      { _tag: "Restack", canvas: "factory", nodes: ["room", "nodes", "lead", "plan", "tasks"], to: "front" },
    ]);
    const without = doc(base.nodes.filter((node) => node.id !== "plan"), [...base.edges]);
    expect(sent(base, without).map((command) => command._tag)).toEqual(["Remove"]);
  });

  it("several changes at once arrive together", () => {
    const after = doc(
      [
        ...base.nodes
          .filter((node) => node.id !== "nodes")
          .map((node) => (node.id === "plan" ? ({ ...node, x: 9, text: "moved", color: "2" } as CanvasNode) : node)),
        note("extra", "new"),
      ],
      [base.edges[1]!, edge("w3", "lead", "extra")],
    );
    const commands = arrives(base, after);
    expect(commands.map((command) => command._tag)).toEqual(["Remove", "Add", "Move", "Recolor", "Edit"]);
  });
});

describe("what a document cannot decide", () => {
  it("never gives or takes overseer authority, and never records a session", () => {
    const plain = doc([seat("lead")]);
    const granted = doc([seat("lead", { overseer: true })]);
    const sessioned = doc([seat("lead", {}, { sessionId: "sess-9" })]);
    expect(documentEdits("factory", plain, granted, 0)).toEqual([]);
    expect(documentEdits("factory", granted, plain, 0)).toEqual([]);
    expect(documentEdits("factory", plain, sessioned, 0)).toEqual([]);
  });

  it("adds a seat without authority even when the document claims it", () => {
    const [add] = documentEdits("factory", doc([]), doc([seat("lead", { overseer: true })]), 0);
    if (add?._tag !== "Add") throw new Error("expected an Add");
    expect(add.nodes[0]).toMatchObject({ kind: "agent", overseer: false });
  });

  it("sends nothing for work a node carries, which is not the canvas's to change", () => {
    const before = doc([board("tasks", { items: [] })]);
    const after = doc([board("tasks", { items: [{ id: "t1", state: "submitted", history: [] }] })]);
    expect(documentEdits("factory", before, after, 0)).toEqual([]);
  });

  it("leaves out a line that is not a wire", () => {
    const before = doc([note("a", "a"), note("b", "b")]);
    const after = doc([note("a", "a"), note("b", "b")], [edge("line", "a", "b", {})]);
    expect(documentEdits("factory", before, after, 0)).toEqual([]);
  });
});
