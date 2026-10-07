import { describe, expect, it, vi } from "vitest";
import { Effect, Layer, Result, Schema } from "effect";
import type { CanvasDoc } from "../src/shared/canvas";
import { asCanvasName, type Changed } from "../src/shared/model";
import { canvasFromDocument, nodeFromDocument } from "../src/shared/model/from-document";
import { InstallationId } from "../src/shared/installation-id";
import { CommandCenterConfiguration } from "../src/shared/station-api";
import { ModelActorRefs } from "../src/main/junto/model/actor-refs";
import { ModelService } from "../src/main/junto/model/service";
import { StationRepository } from "../src/main/junto/station/repository";
import { deriveActorSeatId } from "../src/main/junto/station/actor-seat-compiler";
import {
  resolveOverseerActor,
  watchOverseerRevocation,
  type OverseerSeatRead,
} from "../src/main/junto/overseer/admission";

const local = Schema.decodeUnknownSync(InstallationId)("cc-test");
const remote = Schema.decodeUnknownSync(InstallationId)("remote-test");
const caller = { canvasName: "factory", nodeId: "planner" };
type DocNode = CanvasDoc["nodes"][number];
const planner = (ether: DocNode["ether"]): DocNode => ({
  id: "planner", type: "text", text: "Planner", x: 17, y: -29, width: 300, height: 200, ether,
});
const seatEther = {
  entity: { kind: "agent", name: "remote:planner" },
  host: "remote", overseer: true,
  terminal: { bindingId: "planner-binding", harness: "claude" },
} as const;
/** The canvas as the model reads a document whose one node carries this. */
const canvasOf = (ether: DocNode["ether"]) =>
  canvasFromDocument("factory", { nodes: [planner(ether)], edges: [] });
const fixture = (home = remote, ether: DocNode["ether"] = seatEther): OverseerSeatRead => ({
  name: "factory",
  actorRefs: [{ ...caller, seatId: deriveActorSeatId(home, "planner-binding") }],
  canvas: canvasOf(ether),
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
      { ...seatEther, overseer: false },
      { ...seatEther, overseer: undefined },
      { ...seatEther, entity: { kind: "terminal", name: "remote:planner" } },
      { ...seatEther, terminal: undefined },
    ]) {
      const changed = fixture(remote, ether as DocNode["ether"]);
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

  it("rechecks on a change that leaves the seat as it was, and latches a rapid off and on", async () => {
    const read = fixture();
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
      Layer.mock(StationRepository, {
        installationId: Effect.succeed(local),
        configuration: Effect.succeed({
          configuredAt: "2026-09-11T00:00:00Z",
          configuration: Schema.decodeUnknownSync(CommandCenterConfiguration)({
            role: "command-center", hostId: "local", supervisedPreferred: false,
          }),
        }),
      }),
    );
    /** One committed change to the canvas that carries the seat as given. */
    let seq = 0;
    const changed = (ether?: DocNode["ether"]): Changed => ({
      canvas: asCanvasName("factory"),
      seq: ++seq,
      nodes: ether === undefined ? [] : [nodeFromDocument("factory", planner(ether), 0)],
      wires: [],
      removedNodes: [],
      removedWires: [],
    } as Changed);
    const abort = new AbortController();
    const watching = Effect.runPromise(
      watchOverseerRevocation(caller, read.actorRefs[0]!, remote).pipe(
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
      listener!(changed(seatEther));
      await vi.waitFor(() => expect(reads).toBe(3));
      expect(settled).toBe(false);
      // The next live read already sees the restored grant. The commit event
      // must still cancel the command that held the old grant.
      listener!(changed({ ...seatEther, overseer: false }));
      listener?.(changed(seatEther));
      expect(await watching).toMatchObject({ _tag: "Failure", failure: { type: "ScopeError" } });
      expect(listener).toBeUndefined();
    } finally {
      abort.abort();
    }
  });
});
