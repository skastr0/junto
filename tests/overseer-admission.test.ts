import { describe, expect, it } from "vitest";
import { Result, Schema } from "effect";
import type { CanvasReadResult } from "../src/shared/ipc";
import { InstallationId } from "../src/shared/installation-id";
import { deriveActorSeatId } from "../src/main/vellum-command/station/actor-seat-compiler";
import { resolveOverseerActor } from "../src/main/vellum-command/overseer/admission";

const local = Schema.decodeUnknownSync(InstallationId)("cc-test");
const remote = Schema.decodeUnknownSync(InstallationId)("remote-test");
const caller = { canvasName: "factory", nodeId: "planner" };
const fixture = (home = remote): CanvasReadResult => ({
  name: "factory",
  revision: "revision",
  workRevision: "0",
  actorRefs: [{ ...caller, seatId: deriveActorSeatId(home, "planner-binding") }],
  doc: {
    nodes: [{
      id: "planner", type: "text", text: "Planner", x: 17, y: -29, width: 300, height: 200,
      ether: {
        entity: { kind: "agent", name: "remote:planner" },
        host: "remote", overseer: true,
        terminal: { bindingId: "planner-binding", harness: "claude" },
      },
    }],
    edges: [],
  },
});

describe("overseer installation admission", () => {
  it("admits a no-edge Remote overseer as its real compiled actor", () => {
    const read = fixture();
    expect(resolveOverseerActor(caller, read, remote)).toEqual(Result.succeed(read.actorRefs[0]));
    const ccRead = fixture(local);
    expect(resolveOverseerActor(caller, ccRead, local)).toEqual(Result.succeed(ccRead.actorRefs[0]));
  });

  it("refuses a claimed node id belonging to another authenticated installation", () => {
    expect(resolveOverseerActor(caller, fixture(), local)).toMatchObject({
      _tag: "Failure", failure: { type: "ScopeError" },
    });
  });

  it("requires the live human grant, a complete actor, and exact canvas identity", () => {
    for (const ether of [
      { ...fixture().doc.nodes[0]!.ether, overseer: false },
      { ...fixture().doc.nodes[0]!.ether, overseer: undefined },
      { ...fixture().doc.nodes[0]!.ether, entity: { kind: "terminal", name: "remote:planner" } },
      { ...fixture().doc.nodes[0]!.ether, terminal: undefined },
    ]) {
      const read = fixture();
      const changed = { ...read, doc: { nodes: [{ ...read.doc.nodes[0]!, ether }], edges: [] } };
      expect(Result.isFailure(resolveOverseerActor(caller, changed, remote))).toBe(true);
    }
    expect(Result.isFailure(resolveOverseerActor(caller, { ...fixture(), name: "another" }, remote))).toBe(true);
  });

  it("rejects missing, ambiguous, or stale compiled execution references", () => {
    const read = fixture();
    for (const actorRefs of [
      [],
      [...read.actorRefs, ...read.actorRefs],
      [{ ...caller, seatId: deriveActorSeatId(remote, "replacement-binding") }],
    ]) {
      expect(Result.isFailure(resolveOverseerActor(caller, { ...read, actorRefs }, remote))).toBe(true);
    }
  });
});
