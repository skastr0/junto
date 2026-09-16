import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../src/shared/ipc";
import type { CanvasNode } from "../src/shared/canvas";
import { registerTerminalIpc } from "../src/main/junto/term/ipc";
import type { TermPlane } from "../src/main/junto/term/plane";
import { TerminalNodeDeleteService } from "../src/main/junto/term/node-delete";
import type { HarnessId } from "../src/shared/managed-terminal-templates";

const sender = {
  isDestroyed: () => false,
  send: vi.fn(),
};
const event = { sender };

type Handler = (...args: readonly unknown[]) => unknown;

const harness = (options: {
  readonly ensureHostAvailable?: (hostId: string) => Promise<void>;
} = {}) => {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    },
  };
  const router = Object.assign(new EventEmitter(), {
    isLocalHostId: (hostId: string | undefined | null) =>
      hostId === undefined || hostId === null || hostId.trim() === "" ||
      hostId === "local" || hostId === "cc-local",
    create: vi.fn(async (input: unknown) => ({
      bindingId: (input as { bindingId: string }).bindingId,
      epoch: "created",
      hostId: "local",
      status: "running",
      cwd: "/tmp",
      cols: 80,
      rows: 24,
      detached: true,
      createdAt: 1,
    })),
    deleteBinding: vi.fn(async () => true),
    release: vi.fn(),
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

const geographyNode = (
  bindingId: string,
  hostId: string,
): CanvasNode => ({
  id: `node-${bindingId}`,
  type: "text",
  text: bindingId,
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ether: {
    host: hostId,
    entity: { kind: "terminal" },
    terminal: { bindingId },
  },
});

const agentNode = (
  bindingId: string,
  hostId: string,
  harnessId: HarnessId,
  agentKey: string,
): CanvasNode => ({
  id: `node-${bindingId}`,
  type: "text",
  text: bindingId,
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ether: {
    host: hostId,
    entity: { kind: "agent", name: agentKey },
    terminal: {
      bindingId,
      harness: harnessId,
      launch: { kind: "harness", argv: [harnessId] },
    },
  },
});

describe("terminal IPC node-delete admission", () => {
  it("revokes a create that was awaiting host activation before deletion", async () => {
    let finishHostActivation!: () => void;
    const hostActivation = new Promise<void>((resolve) => {
      finishHostActivation = resolve;
    });
    const ensureHostAvailable = vi.fn(() => hostActivation);
    const runtime = harness({ ensureHostAvailable });
    runtime.router.deleteBinding.mockResolvedValueOnce(false);

    const create = Promise.resolve(runtime.handler(IPC_CHANNELS.terminalCreate)(
      event,
      { node: geographyNode("binding-race", "remote-race") },
    ));
    await vi.waitFor(() => expect(ensureHostAvailable).toHaveBeenCalledOnce());

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

  it("routes Prime Agent to a Remote host; local-only harnesses stay refused", async () => {
    const hostSentinel = new Error("host activation sentinel");
    const ensureHostAvailable = vi.fn(async () => {
      throw hostSentinel;
    });
    const runtime = harness({ ensureHostAvailable });

    // Claude remains a local-only harness: the badge gate refuses before any
    // host activation or seat occupation.
    await expect(Promise.resolve(runtime.handler(IPC_CHANNELS.terminalCreate)(
      event,
      {
        node: agentNode("claude-remote", "remote-a", "claude", "local:claude-remote"),
        canvasName: "factory",
      },
    ))).rejects.toThrow(/local-only.*Remote/u);
    expect(ensureHostAvailable).not.toHaveBeenCalled();

    // Prime Agent is remote-capable: the create passes the badge gate and
    // reaches host activation for the Remote target. The sentinel stops the
    // flow there so the ordering is proven without occupying a real seat.
    await expect(Promise.resolve(runtime.handler(IPC_CHANNELS.terminalCreate)(
      event,
      {
        node: agentNode("prime-remote", "remote-a", "prime-agent", "local:prime-remote"),
        canvasName: "factory",
      },
    ))).rejects.toThrow(hostSentinel);
    expect(ensureHostAvailable).toHaveBeenCalledWith("remote-a");
  });
});
