import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { Command, decodeCommand, decodeNode, decodeWire, isSeat, NODE_KINDS, Node, NodeEdit } from "./index";

const placed = { id: "n1", x: 0, y: 0, width: 216, height: 96, z: 0 };

const seat = {
  kind: "agent",
  ...placed,
  agentKey: "local:claude",
  label: "canvas-lead",
  host: "local",
  overseer: false,
  bindingId: "01M46VAYSKXYFKW4QX1NHBXCCP",
  harness: "claude",
  onRemove: "detach",
};

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSyncExit(effect);

describe("model", () => {
  it("reads a seat as a seat", () => {
    const exit = run(decodeNode(seat));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(isSeat(exit.value)).toBe(true);
      expect(exit.value.kind === "agent" && exit.value.harness).toBe("claude");
    }
  });

  it("has a member for every kind word, and no other", () => {
    const members = Node.members.map((member) => member.fields.kind.literal);
    expect([...members].sort()).toEqual([...NODE_KINDS].sort());
  });

  it("refuses a kind it does not know", () => {
    expect(Exit.isFailure(run(decodeNode({ ...placed, kind: "orbit" })))).toBe(true);
  });

  it("refuses a field the kind does not have", () => {
    const bagged = { ...seat, extension: { messages: { items: [] } } };
    expect(Exit.isFailure(run(decodeNode(bagged)))).toBe(true);
    expect(Exit.isFailure(run(decodeNode({ ...seat, messages: [] })))).toBe(true);
  });

  it("refuses a seat without a harness or a session binding", () => {
    const { harness: _harness, ...noHarness } = seat;
    const { bindingId: _bindingId, ...noBinding } = seat;
    expect(Exit.isFailure(run(decodeNode(noHarness)))).toBe(true);
    expect(Exit.isFailure(run(decodeNode(noBinding)))).toBe(true);
  });

  it("reads a wire and refuses one with no verb", () => {
    const wire = { id: "w1", from: "n1", to: "n2", verb: "messages" };
    expect(Exit.isSuccess(run(decodeWire(wire)))).toBe(true);
    const { verb: _verb, ...noVerb } = wire;
    expect(Exit.isFailure(run(decodeWire(noVerb)))).toBe(true);
    expect(Exit.isFailure(run(decodeWire({ ...wire, label: "x" })))).toBe(true);
    expect(Exit.isFailure(run(decodeWire({ ...wire, to: "n1" })))).toBe(true);
    expect(Exit.isFailure(run(decodeWire({ ...wire, from: "" })))).toBe(true);
  });
});

describe("commands", () => {
  const decode = (input: unknown) => run(decodeCommand(input));

  it("moves many nodes in one command", () => {
    const exit = decode({
      _tag: "Move",
      canvas: "factory",
      moves: [{ id: "n1", x: 10, y: 20 }, { id: "n2", x: 0, y: 0, size: { width: 300, height: 200 } }],
    });
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("edits only the fields a kind has", () => {
    const edit = (change: unknown) =>
      decode({ _tag: "Edit", canvas: "factory", id: "n1", change });
    expect(Exit.isSuccess(edit({ kind: "agent", label: "lead", launch: null }))).toBe(true);
    expect(Exit.isSuccess(edit({ kind: "region", hold: true, instruction: null }))).toBe(true);
    expect(Exit.isFailure(edit({ kind: "note", harness: "claude" }))).toBe(true);
  });

  it("sends nodes to the front or the back", () => {
    const restack = (to: string) =>
      decode({ _tag: "Restack", canvas: "factory", nodes: ["n1", "n2"], to });
    expect(Exit.isSuccess(restack("front"))).toBe(true);
    expect(Exit.isFailure(restack("middle"))).toBe(true);
  });

  it("keeps a seat's label to one line", () => {
    expect(Exit.isFailure(run(decodeNode({ ...seat, label: "a\nb" })))).toBe(true);
  });

  it("cannot change who a seat is", () => {
    const edit = (change: unknown) =>
      decode({ _tag: "Edit", canvas: "factory", id: "n1", change });
    expect(Exit.isFailure(edit({ kind: "agent", agentKey: "local:other" }))).toBe(true);
    expect(Exit.isFailure(edit({ kind: "agent", bindingId: "other" }))).toBe(true);
  });

  it("cannot make a seat an overseer by editing it", () => {
    const edit = (change: unknown) =>
      decode({ _tag: "Edit", canvas: "factory", id: "n1", change });
    expect(Exit.isFailure(edit({ kind: "agent", overseer: true }))).toBe(true);
    expect(
      Exit.isSuccess(decode({ _tag: "GrantOverseer", canvas: "factory", id: "n1", overseer: true })),
    ).toBe(true);
  });

  it("refuses an unknown field on a node it carries", () => {
    const add = (node: unknown) =>
      decode({ _tag: "Add", canvas: "factory", nodes: [node], wires: [] });
    expect(Exit.isSuccess(add(seat))).toBe(true);
    expect(Exit.isFailure(add({ ...seat, messages: [] }))).toBe(true);
    expect(Exit.isFailure(add({ ...seat, canvas: "other" }))).toBe(true);
  });

  it("writes a sheet's grid apart from the sheet", () => {
    const grid = { columns: [{ id: "c1", name: "A" }], rows: [{ id: "r1", cells: { c1: "x" } }] };
    expect(Exit.isSuccess(decode({ _tag: "WriteSheet", canvas: "factory", id: "n1", grid }))).toBe(true);
    expect(Exit.isFailure(run(decodeNode({ ...placed, kind: "sheet", ...grid })))).toBe(true);
  });

  it("has an edit for every kind", () => {
    const kinds = NodeEdit.members.map((member) => member.fields.kind.literal);
    expect([...kinds].sort()).toEqual([...NODE_KINDS].sort());
  });

  it("has no command that carries a whole canvas", () => {
    expect(Object.keys(Command.cases).sort()).toEqual([
      "Add",
      "CreateCanvas",
      "Edit",
      "GrantOverseer",
      "Move",
      "Recolor",
      "RecordSession",
      "Remove",
      "RemoveCanvas",
      "RenameCanvas",
      "Restack",
      "Rewire",
      "WriteSheet",
    ]);
  });
});
