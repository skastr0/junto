import { describe, expect, it, vi } from "vitest";
import { Effect, Layer, Result, Schema } from "effect";
import { asCanvasName, type Changed, type Node } from "../src/shared/model";
import { canvasOf, note, page, seat, terminal } from "./support/model-nodes";
import { InstallationId } from "../src/shared/installation-id";
import { ModelActorRefs } from "../src/main/junto/model/actor-refs";
import { ModelService } from "../src/main/junto/model/service";
import { MachineRepository } from "../src/main/junto/machines/repository";
import { THIS_MACHINE } from "./support/machines";
import { deriveActorSeatId } from "../src/main/junto/actor-seat-id";
import {
  resolveOverseerActor,
  watchOverseerRevocation,
  type OverseerSeatRead,
} from "../src/main/junto/overseer/admission";

const local = Schema.decodeUnknownSync(InstallationId)("cc-test");
const remote = Schema.decodeUnknownSync(InstallationId)("remote-test");
const caller = { canvasName: "factory", nodeId: "planner" };
const frame = { x: 17, y: -29, width: 300, height: 200 };
/** The planner as the operator made it: a seat on the remote, granted. */
const plannerSeat: Node = seat("planner", {
  ...frame, label: "Planner", agentKey: "remote:planner", host: "remote", overseer: true,
  bindingId: "planner-binding" as never,
});
/**
 * One canvas holding this node under the planner's id, with the actor
 * reference the planner seat compiles to. The reference is the same whatever
 * the node is, so a case below fails for the node and nothing else.
 */
const fixture = (home = remote, node: Node = plannerSeat): OverseerSeatRead => ({
  name: "factory",
  actorRefs: [{ ...caller, seatId: deriveActorSeatId(home, "planner-binding") }],
  canvas: canvasOf([node]),
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

  it("admits only a seat the operator granted: a matching actor reference alone admits nothing", () => {
    // Each of these sits under the planner's id with the planner's own
    // actor reference, so the reference matches and only the node differs.
    const notASeat: ReadonlyArray<readonly [string, Node]> = [
      ["a seat with the grant off", { ...plannerSeat, overseer: false } as Node],
      ["a terminal on the planner's session", terminal("planner", { ...frame, host: "remote", bindingId: "planner-binding" as never })],
      ["a note", note("planner", "Planner", frame)],
      ["a page", page("planner", frame)],
    ];
    for (const [what, node] of notASeat) {
      const result = resolveOverseerActor(caller, fixture(remote, node), remote);
      expect(result, what).toMatchObject({
        _tag: "Failure",
        failure: { type: "ScopeError", message: "the caller no longer has human-granted overseer authority" },
      });
    }
    // The same seat, read from a canvas of another name.
    expect(Result.isFailure(resolveOverseerActor(caller, { ...fixture(), name: "another" }, remote))).toBe(true);
    // And a granted seat on another session than the reference names.
    const moved = { ...plannerSeat, bindingId: "other-binding" } as Node;
    expect(resolveOverseerActor(caller, fixture(remote, moved), remote)).toMatchObject({
      _tag: "Failure",
      failure: { type: "ScopeError", message: "overseer caller does not belong to the authenticated installation" },
    });
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

  it("rechecks on a change that leaves the seat as it was, and latches a rapid off and on", async () => {
    // Overseer commands come from an occupant on this machine.
    const read = fixture(local);
    let listener: ((event: Changed) => void) | undefined;
    let reads = 0;
    let settled = false;
    const layers = Layer.mergeAll(
      Layer.succeed(ModelService, {
        canvas: () => Effect.sync(() => { reads++; return read.canvas; }),
        subscribeChanges: (callback: (event: Changed) => void) => {
          listener = callback;
          return () => { listener = undefined; };
        },
        subscribeCanvasesChanges: () => () => undefined,
      } as never),
      Layer.succeed(ModelActorRefs, { read: () => Effect.succeed(read.actorRefs) } as never),
      Layer.mock(MachineRepository, {
        installationId: Effect.succeed(local),
        machineName: Effect.succeed(THIS_MACHINE),
        configuration: Effect.succeed({
          configuredAt: "2026-09-11T00:00:00Z",
          configuration: { name: THIS_MACHINE, supervisedPreferred: false },
        }),
      }),
    );
    /** One committed change to the canvas that carries the seat as given. */
    let seq = 0;
    const changed = (node?: Node): Changed => ({
      canvas: asCanvasName("factory"),
      seq: ++seq,
      nodes: node === undefined ? [] : [node],
      wires: [],
      removedNodes: [],
      removedWires: [],
    } as Changed);
    const abort = new AbortController();
    const watching = Effect.runPromise(
      watchOverseerRevocation(caller, read.actorRefs[0]!, local).pipe(
        Effect.result,
        Effect.provide(layers),
      ),
      { signal: abort.signal },
    ).then((result) => { settled = true; return result; });
    try {
      await vi.waitFor(() => expect(reads).toBe(1));
      // Another node changed.
      listener!(changed());
      await vi.waitFor(() => expect(reads).toBe(2));
      expect(settled).toBe(false);
      // The seat itself was written again, the same seat.
      listener!(changed(plannerSeat));
      await vi.waitFor(() => expect(reads).toBe(3));
      expect(settled).toBe(false);
      // The next live read already sees the restored grant. The commit event
      // must still cancel the command that held the old grant.
      listener!(changed({ ...plannerSeat, overseer: false } as Node));
      listener?.(changed(plannerSeat));
      expect(await watching).toMatchObject({ _tag: "Failure", failure: { type: "ScopeError" } });
      expect(listener).toBeUndefined();
    } finally {
      abort.abort();
    }
  });
});
