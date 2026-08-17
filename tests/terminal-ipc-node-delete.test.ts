import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../src/shared/ipc";
import { registerTerminalIpc } from "../src/main/vellum/term/ipc";
import type { TermPlane } from "../src/main/vellum/term/plane";

// The install probe reads the real machine; pin it so admission tests stay
// machine-independent.
vi.mock("../src/main/vellum/term/templates/harness-install", () => ({
  isManagedHarnessInstalled: () => true,
}));

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
    createAgentSeat: vi.fn(),
    deleteBinding: vi.fn(async () => true),
    release: vi.fn(),
  });
  registerTerminalIpc(
    ipcMain as never,
    { router } as unknown as TermPlane,
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
      { bindingId: "binding-race", hostId: "remote-race" },
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
    const ensureHostAvailable = vi.fn(async () => undefined);
    const runtime = harness({ ensureHostAvailable });

    // Claude remains a local-only harness: the badge gate refuses before any
    // host activation or install probing.
    await expect(Promise.resolve(runtime.handler(IPC_CHANNELS.terminalCreate)(
      event,
      {
        bindingId: "claude-remote",
        hostId: "remote-a",
        harness: "claude",
        agentKey: "local:claude-remote",
      },
    ))).rejects.toThrow(/local-only.*Remote/u);
    expect(ensureHostAvailable).not.toHaveBeenCalled();
    expect(runtime.router.createAgentSeat).not.toHaveBeenCalled();

    // Prime Agent is remote-capable: the create proceeds through host
    // activation to the router.
    const summary = {
      bindingId: "prime-remote",
      epoch: "prime-remote-epoch",
      hostId: "remote-a",
      status: "running",
      cwd: "/tmp",
      cols: 80,
      rows: 24,
      detached: true,
      createdAt: 1,
    };
    runtime.router.createAgentSeat.mockResolvedValueOnce(summary);
    await expect(Promise.resolve(runtime.handler(IPC_CHANNELS.terminalCreate)(
      event,
      {
        bindingId: "prime-remote",
        hostId: "remote-a",
        harness: "prime-agent",
        agentKey: "local:prime-remote",
      },
    ))).resolves.toMatchObject({ bindingId: "prime-remote" });
    expect(ensureHostAvailable).toHaveBeenCalledWith("remote-a");
    expect(runtime.router.createAgentSeat).toHaveBeenCalledWith(
      expect.objectContaining({
        bindingId: "prime-remote",
        harness: "prime-agent",
        hostId: "remote-a",
      }),
    );
  });
});
