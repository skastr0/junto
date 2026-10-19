import { Effect } from "effect";
import { expect, it } from "vitest";
import { OPERATOR_PROTOCOL_VERSION, type OperatorRequestEnvelope, type OperatorResponseEnvelope } from "../src/shared/operator-control";
import { boatOwnerDispatch } from "../src/main/junto/boat/owner";
import type { BoatMachines } from "../src/main/junto/boat/machines";

const request = (op: string, args: unknown) => ({ protocol: OPERATOR_PROTOCOL_VERSION, id: "r1", op, args }) as OperatorRequestEnvelope;
const okFor = (req: OperatorRequestEnvelope) => ({ protocol: OPERATOR_PROTOCOL_VERSION, id: req.id, op: req.op, ok: true, data: {} }) as unknown as OperatorResponseEnvelope;

const harness = (boatNames: ReadonlyArray<string>, wakeFails = false) => {
  const order: string[] = [];
  const machines = {
    record: async (name: string) => boatNames.includes(name) ? { name, sandboxId: "bx_test01", size: "small" } : undefined,
    wake: async (name: string, options?: { core?: boolean }) => {
      order.push(`wake:${name}:${options?.core}`);
      if (wakeFails) throw Object.assign(new Error("boat-one did not wake in time"), { _tag: "BoatMachineRefused" });
      return {};
    },
  } as unknown as BoatMachines;
  const owner = {
    handle: async () => ({}),
    refreshRoute: async (name: string) => { order.push(`route:${name}`); },
    renewKey: async (name: string) => { order.push(`key:${name}`); },
    retire: async (name: string, deleted: boolean) => { order.push(`retire:${name}:${deleted}`); },
  } as unknown as Parameters<typeof boatOwnerDispatch>[0];
  const dispatch = boatOwnerDispatch(owner, machines, (req) => Effect.sync(() => { order.push(req.op); return okFor(req); }));
  return { order, dispatch };
};

it("wakes a Boat machine and finds its route before a send, and passes others straight through", async () => {
  const boat = harness(["boat-one"]);
  await Effect.runPromise(boat.dispatch(request("machine.send", { name: "boat-one" })));
  expect(boat.order).toEqual(["wake:boat-one:false", "route:boat-one", "machine.send"]);
  const plain = harness([]);
  await Effect.runPromise(plain.dispatch(request("machine.send", { name: "studio" })));
  expect(plain.order).toEqual(["machine.send"]);
});

it("places a new machine key after an update, and leaves Boat's side after a remove with the sandbox kept", async () => {
  const boat = harness(["boat-one"]);
  await Effect.runPromise(boat.dispatch(request("machine.update", { name: "boat-one" })));
  await Effect.runPromise(boat.dispatch(request("machine.remove", { name: "boat-one" })));
  expect(boat.order).toEqual(["wake:boat-one:false", "route:boat-one", "machine.update", "key:boat-one", "machine.remove", "retire:boat-one:false"]);
});

it("answers a wake that failed with its own sentence and sends nothing", async () => {
  const boat = harness(["boat-one"], true);
  const response = await Effect.runPromise(boat.dispatch(request("machine.send", { name: "boat-one" })));
  expect(response).toMatchObject({ ok: false, error: { message: "boat-one did not wake in time" } });
  expect(boat.order).toEqual(["wake:boat-one:false"]);
});

it("never answers with a cause's own text", async () => {
  const machines = { record: async () => undefined } as unknown as BoatMachines;
  const owner = { handle: async () => { throw new Error("boat_SECRET000000000000000000000000 leaked"); } } as unknown as Parameters<typeof boatOwnerDispatch>[0];
  const dispatch = boatOwnerDispatch(owner, machines, (req) => Effect.succeed(okFor(req)));
  const response = await Effect.runPromise(dispatch(request("machine.boat-status", {})));
  expect(response).toMatchObject({ ok: false, error: { message: "The Boat machine command failed" } });
  expect(JSON.stringify(response)).not.toContain("boat_SECRET");
});
