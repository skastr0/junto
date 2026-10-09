import { describe, expect, it } from "vitest";
import {
  callerGrantLive,
  callerSeatBinding,
  canvasDeleteRetiresCaller,
  nativeDeleteResourcesOf,
  planOverseerSteps,
  removalIncludesCaller,
  removalRetiresCallerBinding,
  seatDraftRefusal,
  type OverseerCanvases,
} from "../src/shared/overseer-rules";
import type { OverseerCanvasBatchStep } from "../src/shared/overseer-control";
import type { NodeOf } from "../src/shared/model";
import { canvasOf, note, page, region, seat, wire } from "./support/model-nodes";
import { OTHER_MACHINE, THIS_MACHINE } from "./support/machines";

// The overseer's rules as pure checks over the model: what a batch of steps
// becomes, and what is refused before anything is sent.

const binding = (id: string) => id as NodeOf<"agent">["bindingId"];
const caller = { canvasName: "ops", nodeId: "boss" };

const canvases = (): OverseerCanvases =>
  new Map([
    ["ops", canvasOf(
      [
        seat("boss", { overseer: true, bindingId: binding("bind-boss") }),
        seat("peer", { bindingId: binding("bind-peer") }),
        note("n1"),
        note("n2"),
        page("web"),
        region("box", { x: 0, y: 0, width: 10, height: 10 }),
      ],
      [wire("held", "boss", "peer", "messages")],
    )],
    ["other", canvasOf([seat("alias", { bindingId: binding("bind-boss") })])],
  ]);

const plan = (steps: ReadonlyArray<unknown>, canvas = "ops") => {
  let minted = 0;
  return planOverseerSteps({
    canvases: canvases(),
    canvas,
    caller,
    steps: steps as ReadonlyArray<OverseerCanvasBatchStep>,
    mintId: (kind) => `${kind}-${++minted}`,
  });
};

const refusal = (steps: ReadonlyArray<unknown>, canvas = "ops") => {
  const planned = plan(steps, canvas);
  if (planned.ok) throw new Error("expected a refusal");
  return planned.error;
};

describe("planning an overseer's steps", () => {
  it("turns steps into model commands, each later step seeing the earlier ones", () => {
    const planned = plan([
      { operation: "node.create", node: { kind: "note", text: "new", x: 1, y: 2, width: 30, height: 40 } },
      { operation: "node.move", nodeId: "note-1", x: 5, y: 6 },
      { operation: "wire.connect", wire: { from: "peer", to: "boss" } },
      { operation: "wire.disconnect", wireId: "held" },
    ]);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.commands.map((command) => command._tag)).toEqual(["Add", "Move", "Add", "Remove"]);
    expect(planned.results).toMatchObject([
      // Stacked above everything the canvas held.
      { operation: "node.create", nodeId: "note-1", node: { id: "note-1", kind: "note", z: 6 } },
      { operation: "node.move", nodeId: "note-1" },
      { operation: "wire.connect", wireId: "wire-2", wire: { from: "peer", to: "boss", verb: "messages" } },
      { operation: "wire.disconnect", wireId: "held" },
    ]);
  });

  it("refuses with the missing target named", () => {
    expect(refusal([{ operation: "node.move", nodeId: "ghost", x: 0, y: 0 }]))
      .toMatchObject({ type: "NotFound", message: expect.stringContaining("ghost") });
    expect(refusal([{ operation: "wire.disconnect", wireId: "ghost" }]).type).toBe("NotFound");
    expect(refusal([{ operation: "node.move", nodeId: "n1", x: 0, y: 0 }], "nowhere").type).toBe("NotFound");
  });

  it("refuses an id already taken, by a held node or by an earlier step", () => {
    const draft = { kind: "note", id: "n1", text: "x", x: 0, y: 0, width: 10, height: 10 };
    expect(refusal([{ operation: "node.create", node: draft }]).type).toBe("InvalidArguments");
    const fresh = { ...draft, id: "n9" };
    expect(refusal([
      { operation: "node.create", node: fresh },
      { operation: "node.create", node: fresh },
    ]).type).toBe("InvalidArguments");
  });

  it("gives a new seat main's parts, and a session no live overseer holds", () => {
    const planned = plan([{
      operation: "node.create",
      node: { kind: "agent", x: 0, y: 0, width: 260, height: 96, harness: "claude" },
    }]);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const made = (planned.results[0] as { node: NodeOf<"agent"> }).node;
    expect(made).toMatchObject({ kind: "agent", overseer: false, host: THIS_MACHINE, harness: "claude" });
    expect(made.bindingId).not.toBe("bind-boss");
    expect(made.launch?.kind).toBe("harness");
    // A terminal may not be put on an overseer's session, here or on another canvas.
    for (const canvas of ["ops", "other"]) {
      expect(refusal([{
        operation: "node.create",
        node: { kind: "terminal", x: 0, y: 0, width: 10, height: 10, host: THIS_MACHINE, onRemove: "detach", bindingId: "bind-boss" },
      }], canvas).type).toBe("Forbidden");
    }
  });

  it("keeps what a seat runs out of an edit", () => {
    for (const change of [{ kind: "agent", harness: "codex" }, { kind: "agent", host: OTHER_MACHINE }]) {
      expect(refusal([{ operation: "node.configure", nodeId: "peer", change }]))
        .toMatchObject({ type: "Forbidden", message: expect.stringContaining("agent reseat") });
    }
    expect(plan([{ operation: "node.configure", nodeId: "peer", change: { kind: "agent", label: "Peer" } }]).ok)
      .toBe(true);
    expect(refusal([{ operation: "node.configure", nodeId: "n1", change: { kind: "agent", label: "x" } }]))
      .toMatchObject({ type: "InvalidArguments", message: expect.stringContaining("is a note") });
  });

  it("refuses a wire no verb joins, a verb the pair does not take, and a second wire the same way", () => {
    expect(refusal([{ operation: "wire.connect", wire: { from: "n1", to: "n2" } }]).type).toBe("InvalidArguments");
    expect(refusal([{ operation: "wire.connect", wire: { from: "boss", to: "peer", verb: "navigates" } }]).type)
      .toBe("InvalidArguments");
    expect(refusal([{ operation: "wire.connect", wire: { id: "held", from: "peer", to: "boss" } }]).type)
      .toBe("InvalidArguments");
  });
});

describe("what an overseer may not remove", () => {
  it("is its own seat, its own canvas, and any seat on its own session", () => {
    const held = canvases();
    expect(removalIncludesCaller(caller, "ops", new Set(["n1", "boss"]))).toBe(true);
    expect(removalIncludesCaller(caller, "other", new Set(["boss"]))).toBe(false);
    expect(canvasDeleteRetiresCaller(caller, "ops")).toBe(true);
    expect(canvasDeleteRetiresCaller(caller, "other")).toBe(false);
    // The other canvas is not the caller's, yet its seat holds the caller's session.
    const own = callerSeatBinding(held, caller);
    const resources = (canvasName: string, ...ids: string[]) =>
      nativeDeleteResourcesOf(held, [{ canvasName, nodeIds: new Set(ids) }]);
    expect(removalRetiresCallerBinding(own, resources("other", "alias"))).toBe(true);
    expect(removalRetiresCallerBinding(own, resources("ops", "peer"))).toBe(false);
  });

  it("reads its grant from the model, on the seat it speaks from", () => {
    const held = canvases();
    expect(callerGrantLive(held, caller)).toBe(true);
    expect(callerGrantLive(held, { canvasName: "ops", nodeId: "peer" })).toBe(false);
    expect(callerGrantLive(held, { canvasName: "ops", nodeId: "ghost" })).toBe(false);
    expect(callerGrantLive(held, { canvasName: "nowhere", nodeId: "boss" })).toBe(false);
  });

  it("plans the teardown a removed node needs, each session once", () => {
    expect(nativeDeleteResourcesOf(canvases(), [
      { canvasName: "ops", nodeIds: new Set(["peer", "web", "n1"]) },
      { canvasName: "nowhere", nodeIds: new Set(["peer"]) },
    ])).toEqual([
      { kind: "agent", agentKey: "local:peer" },
      { kind: "terminal", bindingId: "bind-peer", hostId: THIS_MACHINE },
      { kind: "page", canvasName: "ops", nodeId: "web" },
    ]);
  });
});

describe("a seat draft that names what main works out", () => {
  it("is refused with the field and what to send", () => {
    const base = { kind: "agent", x: 0, y: 0, width: 1, height: 1, harness: "claude" };
    expect(seatDraftRefusal(base)).toBeUndefined();
    expect(seatDraftRefusal({ kind: "note", launch: {} })).toBeUndefined();
    for (const field of ["agentKey", "bindingId", "launch", "sessionId", "overseer"]) {
      expect(seatDraftRefusal({ ...base, [field]: "x" })).toContain(field);
    }
    expect(seatDraftRefusal({ ...base, overseer: true })).toMatch(/Only the operator/u);
  });
});
