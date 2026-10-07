import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { decodeNode, decodeWire, isSeat, NODE_KINDS, Node } from "./index";

const placed = { canvas: "factory", id: "n1", x: 0, y: 0, width: 216, height: 96, z: 0 };

const seat = {
  kind: "agent",
  ...placed,
  name: "local:claude",
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
    const bagged = { ...seat, ether: { messages: { items: [] } } };
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
    const wire = { canvas: "factory", id: "w1", from: "n1", to: "n2", verb: "messages" };
    expect(Exit.isSuccess(run(decodeWire(wire)))).toBe(true);
    const { verb: _verb, ...noVerb } = wire;
    expect(Exit.isFailure(run(decodeWire(noVerb)))).toBe(true);
    expect(Exit.isFailure(run(decodeWire({ ...wire, label: "x" })))).toBe(true);
  });
});
