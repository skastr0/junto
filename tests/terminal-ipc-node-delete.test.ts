import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../src/shared/ipc";
import { Node, type Node as ModelNode } from "../src/shared/model";
import { Effect, Schema } from "effect";
import { inProcessCore } from "./support/in-process-core";
import { core } from "../src/main/core-process/main-client";
import * as seatControl from "../src/main/junto/term/seat-control";
import { registerTerminalIpc } from "../src/main/junto/term/ipc";
import type { TermPlane } from "../src/main/junto/term/plane";
import { TerminalNodeDeleteService } from "../src/main/junto/term/node-delete";
import { ModelService } from "../src/main/junto/model/service";
import type { HarnessId } from "../src/shared/managed-terminal-templates";

/** Polls until the check passes (bun has no vi.waitFor). */
const eventually = async (check: () => void, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { return check(); } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
};

const sender = {
  isDestroyed: () => false,
  send: vi.fn(),
};
const event = { sender };

type Handler = (...args: readonly unknown[]) => unknown;

// Core operations run with no services: the seat read answers `node`, and
// seat start and stop are the spied seat-control effects.
const noServices = inProcessCore({ runPromiseExit: (effect) => Effect.runPromiseExit(effect as never) });
// The terminal start reads the seat again in the core, after its admission.
const coreWithSeat = (node: ModelNode | undefined) => {
  const canvas = { nodes: new Map(node === undefined ? [] : [[node.id, node]]) };
  const withSeat = inProcessCore({ runPromiseExit: (effect) =>
    Effect.runPromiseExit(Effect.provideService(effect as never, ModelService, { canvas: () => Effect.succeed(canvas) } as never) as never) });
  return vi.spyOn(core, "call").mockImplementation(((name: string, input: never) =>
    name === "term.seatNode" ? Promise.resolve(node) : withSeat.call(name as never, input)) as typeof core.call);
};

const harness = (options: {
  readonly ensureHostAvailable?: (hostId: string) => Promise<void>;
  readonly node?: ModelNode;
} = {}) => {
  if (options.node) coreWithSeat(options.node);
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
  registerTerminalIpc(
    ipcMain as never,
    { router, nodeDelete: new TerminalNodeDeleteService(router as never) } as unknown as TermPlane,
    {
      isTrustedSender: () => true,
      ensureHostAvailable: options.ensureHostAvailable,
      broadcast: () => {},
    },
  );
  const handler = (channel: string): Handler => {
    const value = handlers.get(channel);
    if (value === undefined) throw new Error(`missing handler ${channel}`);
    return value;
  };
  return { handler, router };
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
afterEach(() => vi.restoreAllMocks());

describe("terminal IPC node-delete admission", () => {
  it("revokes a create that was awaiting host activation before deletion", async () => {
    let finishHostActivation!: () => void;
    const hostActivation = new Promise<void>((resolve) => {
      finishHostActivation = resolve;
    });
    const ensureHostAvailable = vi.fn(() => hostActivation);
    const runtime = harness({ ensureHostAvailable, node: geographyNode("binding-race", "remote-race") });
    runtime.router.deleteBinding.mockResolvedValueOnce(false);

    const create = Promise.resolve(runtime.handler(IPC_CHANNELS.modelStart)(
      event,
      { canvas: "factory", id: "node-binding-race" },
    ));
    await eventually(() => expect(ensureHostAvailable).toHaveBeenCalledOnce());

    const began = await runtime.handler(
      IPC_CHANNELS.terminalBeginNodeDelete,
    )(event, [{ bindingId: "binding-race", hostId: "remote-race" }]);
    // Remote exact deletion is currently refused, but the begin call still
    // increments the revision before it awaits that receipt.
    expect(began).toMatchObject({ ok: false });
    finishHostActivation();

    await expect(create).rejects.toThrow(/revoked by node deletion/u);
    expect(runtime.router.create).not.toHaveBeenCalled();
  });

  it("starts an agent seat through seat control, with the window's host step", async () => {
    const ensureHostAvailable = vi.fn(async () => {});
    const runtime = harness({ ensureHostAvailable });
    const node = agentNode("codex-mini", "mini", "codex", "mini:codex-mini");
    const occupied = { bindingId: "codex-mini", status: "running" };
    const start = vi.spyOn(seatControl, "startSeat").mockReturnValue(Effect.succeed(occupied) as never);
    coreWithSeat(node);
    expect(await runtime.handler(IPC_CHANNELS.modelStart)(event, {
      id: node.id, canvas: "factory",
    })).toEqual(occupied);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(
      { canvas: "factory", seatId: node.id },
      { plane: expect.anything(), ensureHostAvailable: expect.any(Function) },
    );
    expect(runtime.router.create).not.toHaveBeenCalled();
  });

  it("stops an agent seat through seat control, a plain terminal through the router", async () => {
    const runtime = harness();
    const node = agentNode("codex-mini", "mini", "codex", "mini:codex-mini");
    const stop = vi.spyOn(seatControl, "stopSeat").mockReturnValue(Effect.succeed({ outcome: "stopping" }) as never);
    coreWithSeat(node);
    await runtime.handler(IPC_CHANNELS.modelStop)(event, { id: node.id, canvas: "factory" });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith({ canvas: "factory", seatId: node.id }, { plane: expect.anything() });
    expect(runtime.router.kill).not.toHaveBeenCalled();
  });
});
