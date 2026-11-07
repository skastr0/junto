import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../src/shared/ipc";
import { Node, type Node as ModelNode } from "../src/shared/model";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { RpcTest } from "effect/rpc";
import * as seatControl from "../src/core/term/seat-control";
import { TermCore, TermRpcs } from "../src/contract/core/term-ipc";
import { TermTemplatesCore, TermTemplatesRpcs } from "../src/contract/core/term-templates";
import { TermIpcPlane, TermPlaneHandlers } from "../src/core/ops/term-ipc";
import { TermTemplatesHandlers } from "../src/core/ops/term-templates";
import { TerminalNodeDeleteService } from "../src/core/term/node-delete";
import { ModelService } from "../src/core/model/service";
import type { HarnessId } from "../src/shared/managed-terminal-templates";

vi.mock("../src/app/runtime", () => ({ AppRuntime: ManagedRuntime.make(Layer.empty) }));

const { registerTerminalIpc } = await import("../src/app/term/ipc");

// The handlers on the test's plane and model. A handler that reads a service
// this test does not give fails when it is asked; none of those is asked here.
const termHandlers = TermPlaneHandlers as never as Layer.Layer<
  Layer.Success<typeof TermPlaneHandlers>,
  never,
  TermIpcPlane | ModelService
>;

const sender = {
  isDestroyed: () => false,
  send: vi.fn(),
};
const event = { sender };

type Handler = (...args: readonly unknown[]) => unknown;

const runtimes: Array<ManagedRuntime.ManagedRuntime<TermCore | TermTemplatesCore, never>> = [];

// The core's side of the groups, in this process: the seat read answers the
// seat the test put on the canvas, and seat start and stop are the spied
// seat-control effects.
const harness = async () => {
  let seat: ModelNode | undefined;
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    },
  };
  const router = Object.assign(new EventEmitter(), {
    thisMachineName: () => "workbench",
    isLocalHostId: (hostId: string | undefined | null) =>
      hostId === undefined || hostId === null || hostId.trim() === "" ||
      hostId === "workbench",
    create: vi.fn(async (input: unknown) => ({
      bindingId: (input as { bindingId: string }).bindingId,
      epoch: "created",
      hostId: "workbench",
      status: "running",
      cwd: "/tmp",
      cols: 80,
      rows: 24,
      detached: true,
      createdAt: 1,
    })),
    kill: vi.fn(async () => {}),
    deleteBinding: vi.fn(async () => true),
    release: vi.fn(),
    setTerminalEnvironment: vi.fn(),
  });
  // The plane is the core's; the test gives the handlers its own.
  const plane = { router, nodeDelete: new TerminalNodeDeleteService(router as never) };
  const model = {
    canvas: () => Effect.succeed({ nodes: new Map(seat === undefined ? [] : [[seat.id, seat]]) }),
  };
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.effect(TermCore, RpcTest.makeClient(TermRpcs)),
      Layer.effect(TermTemplatesCore, RpcTest.makeClient(TermTemplatesRpcs)),
    ).pipe(
      Layer.provide(Layer.mergeAll(termHandlers, TermTemplatesHandlers)),
      Layer.provide(Layer.succeed(TermIpcPlane, plane as never)),
      Layer.provide(Layer.succeed(ModelService, model as never)),
    ),
  );
  runtimes.push(runtime);
  registerTerminalIpc(
    ipcMain as never,
    { isTrustedSender: () => true, broadcast: () => {}, surfacePlane: () => undefined },
    await runtime.context(),
  );
  const handler = (channel: string): Handler => {
    const value = handlers.get(channel);
    if (value === undefined) throw new Error(`missing handler ${channel}`);
    return value;
  };
  return {
    handler,
    router,
    place: (node: ModelNode) => {
      seat = node;
    },
  };
};

const geographyNode = (bindingId: string, host: string): ModelNode => Schema.decodeUnknownSync(Node)({
  id: `node-${bindingId}`, kind: "terminal", x: 0, y: 0, width: 200, height: 80, z: 0,
  host, bindingId,
});
const agentNode = (bindingId: string, host: string, harness: HarnessId, agentKey: string): ModelNode => Schema.decodeUnknownSync(Node)({
  id: `node-${bindingId}`, kind: "agent", label: bindingId, x: 0, y: 0, width: 200, height: 80, z: 0,
  host, bindingId, harness, agentKey, overseer: false,
  launch: { kind: "harness", argv: [harness] },
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
});

describe("terminal IPC node-delete admission", () => {
  it("starts an agent seat through seat control, never through the router", async () => {
    const runtime = await harness();
    const node = agentNode("codex-mini", "mini", "codex", "mini:codex-mini");
    const occupied = { bindingId: "codex-mini", status: "running" };
    const start = vi.spyOn(seatControl, "startSeat").mockReturnValue(Effect.succeed(occupied) as never);
    runtime.place(node);
    expect(await runtime.handler(IPC_CHANNELS.modelStart)(event, {
      id: node.id, canvas: "factory",
    })).toEqual(occupied);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith({ canvas: "factory", seatId: node.id }, { plane: expect.anything() });
    expect(runtime.router.create).not.toHaveBeenCalled();
  });

  it("stops an agent seat through seat control, a plain terminal through the router", async () => {
    const runtime = await harness();
    const node = agentNode("codex-mini", "mini", "codex", "mini:codex-mini");
    const stop = vi.spyOn(seatControl, "stopSeat").mockReturnValue(Effect.succeed({ outcome: "stopping" }) as never);
    runtime.place(node);
    await runtime.handler(IPC_CHANNELS.modelStop)(event, { id: node.id, canvas: "factory" });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith({ canvas: "factory", seatId: node.id }, { plane: expect.anything() });
    expect(runtime.router.kill).not.toHaveBeenCalled();
  });
});
