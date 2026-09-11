import { describe, expect, it, vi } from "vitest";
import { Effect, Layer, Result, Schema } from "effect";
import type { CanvasReadResult } from "../src/shared/ipc";
import { InstallationId } from "../src/shared/installation-id";
import { CommandCenterConfiguration } from "../src/shared/station-api";
import { CanvasesService, type CanvasChangeDetail } from "../src/main/vellum-command/canvases";
import { StationRepository } from "../src/main/vellum-command/station/repository";
import { deriveActorSeatId } from "../src/main/vellum-command/station/actor-seat-compiler";
import { resolveOverseerActor, watchOverseerRevocation } from "../src/main/vellum-command/overseer/admission";

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

  it("rechecks Work invalidations without revoking, but latches rapid off/on authorial changes", async () => {
    const read = fixture();
    let listener: ((name: string, detail?: CanvasChangeDetail) => void) | undefined;
    let reads = 0;
    let settled = false;
    const layers = Layer.mergeAll(
      Layer.mock(CanvasesService, {
        start: () => {},
        read: () => Effect.sync(() => { reads++; return read; }),
        subscribeChanges: (callback) => {
          listener = callback;
          return () => { listener = undefined; };
        },
        announceInstalledProjection: () => {},
      }),
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
      listener!(caller.canvasName);
      await vi.waitFor(() => expect(reads).toBe(2));
      expect(settled).toBe(false);
      listener!(caller.canvasName, { previous: read.doc, next: read.doc });
      await vi.waitFor(() => expect(reads).toBe(3));
      expect(settled).toBe(false);
      const revoked = {
        ...read.doc,
        nodes: read.doc.nodes.map((node) => ({
          ...node, ether: { ...node.ether, overseer: false },
        })),
      };
      // The next live read already sees the restored grant. The commit event
      // must still cancel the command that held the old grant.
      listener!(caller.canvasName, { previous: read.doc, next: revoked });
      listener?.(caller.canvasName, { previous: revoked, next: read.doc });
      expect(await watching).toMatchObject({ _tag: "Failure", failure: { type: "ScopeError" } });
      expect(listener).toBeUndefined();
    } finally {
      abort.abort();
      await watching.catch(() => {});
    }
  });
});
