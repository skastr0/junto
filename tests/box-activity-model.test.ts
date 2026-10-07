import { Effect, Schema } from "effect";
import { expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import { Node, asCanvasName } from "../src/shared/model";
import { BoxResource } from "../src/main/junto/box/repository";
import { deriveBoxHostActivity, makeBoxActivityReconciler, type BoxActivityRead } from "../src/main/junto/box/activity-policy";

const seatId = Schema.decodeUnknownSync(ActorSeatId)(`seat_${"c".repeat(64)}`);
const seat = Schema.decodeUnknownSync(Node)({ kind: "agent", id: "worker", label: "Worker", agentKey: "box-c79mgja6:codex", host: "box-c79mgja6", bindingId: "worker", harness: "codex", overseer: false, onRemove: "detach", x: 0, y: 0, width: 100, height: 50, z: 0 });
const read = (name: string, active = true): BoxActivityRead => ({
  canvas: { name: asCanvasName(name), seq: 1, nodes: new Map([[seat.id, seat]]), wires: new Map() },
  actorRefs: [{ canvasName: name, nodeId: seat.id, seatId }],
  items: active ? [{ id: "task", state: "working", claimedBy: seatId, history: [] }] : [],
});
const box = Schema.decodeUnknownSync(BoxResource)({ machine: { id: "bx_c79mgja6", name: "Box", state: "running", ip: null, createdAt: "2026-10-07", updatedAt: "2026-10-07" }, enrolledAt: "2026-10-07" });

it("only a current active claim resolves provider demand to its real seat host", () => {
  expect([...deriveBoxHostActivity([read("factory")]).activeHostIds]).toEqual(["box-c79mgja6"]);
  expect(deriveBoxHostActivity([read("factory", false)]).activeHostIds.size).toBe(0);
  const missing = { ...read("factory"), actorRefs: [] };
  expect(deriveBoxHostActivity([missing])).toMatchObject({ hasUnresolvedActiveWork: true });
  const completed = { ...read("factory"), items: [{ id: "task", state: "completed" as const, claimedBy: seatId, history: [] }] };
  expect(deriveBoxHostActivity([completed]).activeHostIds.size).toBe(0);
  expect(deriveBoxHostActivity([completed]).hasUnresolvedActiveWork).toBe(false);
});

it("a named change rereads only that canvas and a missing read cannot authorize provider sleep", async () => {
  const reads: string[] = [];
  const demand: boolean[] = [];
  let active = false;
  const reconciler = await Effect.runPromise(makeBoxActivityReconciler({
    stationRole: Effect.succeed("command-center"), listCanvasNames: Effect.succeed(["a", "b"]),
    readModel: (name) => Effect.sync(() => { reads.push(name); return read(name, name === "a" && active); }),
    listBoxes: Effect.succeed([box]), setActivityDemand: (_id, requested) => Effect.sync(() => { demand.push(requested); }),
  }));
  await Effect.runPromise(reconciler.reconcile);
  expect(demand).toEqual([false]);
  reads.length = 0;
  active = true;
  reconciler.invalidate("a");
  await Effect.runPromise(reconciler.reconcile);
  expect(reads).toEqual(["a"]);
  expect(demand).toEqual([false, true]);

  const unresolvedDemand: boolean[] = [];
  const missing = await Effect.runPromise(makeBoxActivityReconciler({
    stationRole: Effect.succeed("command-center"), listCanvasNames: Effect.succeed(["missing"]),
    readModel: () => Effect.fail(new Error("cannot read claims")), listBoxes: Effect.succeed([box]),
    setActivityDemand: (_id, requested) => Effect.sync(() => { unresolvedDemand.push(requested); }),
  }));
  await Effect.runPromise(missing.reconcile);
  expect(unresolvedDemand).toEqual([true]);
});
