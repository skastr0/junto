import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../src/shared/ipc";
import { Node, type Node as ModelNode } from "../src/shared/model";
import { Schema } from "effect";
import { AppRuntime } from "../src/main/runtime";
import * as seatControl from "../src/main/junto/term/seat-control";
import { registerTerminalIpc } from "../src/main/junto/term/ipc";
import type { TermPlane } from "../src/main/junto/term/plane";
import { TerminalNodeDeleteService } from "../src/main/junto/term/node-delete";
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

const harness = (options: {
  readonly ensureHostAvailable?: (hostId: string) => Promise<void>;
  readonly node?: ModelNode;
} = {}) => {
  if (options.node) vi.spyOn(AppRuntime, "runPromise").mockResolvedValue(options.node);
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
  host, bindingId, onRemove: "detach",
});
const agentNode = (bindingId: string, host: string, harness: HarnessId, agentKey: string): ModelNode => Schema.decodeUnknownSync(Node)({
  id: `node-${bindingId}`, kind: "agent", label: bindingId, x: 0, y: 0, width: 200, height: 80, z: 0,
  host, bindingId, harness, agentKey, overseer: false, onRemove: "detach",
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
    const start = vi.spyOn(seatControl, "startSeat");
    const occupied = { bindingId: "codex-mini", status: "running" };
    vi.spyOn(AppRuntime, "runPromise").mockResolvedValueOnce(node).mockResolvedValueOnce(occupied);
    expect(await runtime.handler(IPC_CHANNELS.modelStart)(event, {
      id: node.id, canvas: "factory", resume: false,
    })).toEqual(occupied);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(
      { canvas: "factory", seatId: node.id, resume: false },
      { plane: expect.anything(), ensureHostAvailable: expect.any(Function) },
    );
    expect(runtime.router.create).not.toHaveBeenCalled();
  });

  it("stops an agent seat through seat control, a plain terminal through the router", async () => {
    const runtime = harness();
    const node = agentNode("codex-mini", "mini", "codex", "mini:codex-mini");
    const stop = vi.spyOn(seatControl, "stopSeat");
    vi.spyOn(AppRuntime, "runPromise").mockResolvedValueOnce(node).mockResolvedValueOnce({ outcome: "stopping" });
    await runtime.handler(IPC_CHANNELS.modelStop)(event, { id: node.id, canvas: "factory" });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith({ canvas: "factory", seatId: node.id }, { plane: expect.anything() });
    expect(runtime.router.kill).not.toHaveBeenCalled();
  });
});
