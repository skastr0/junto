/**
 * A hidden terminal parks its stream: main sends it no output, it keeps its
 * lease, and shown again it catches up from the main grid. The renderer's
 * bytes scale with the terminals on screen, not the terminals opened.
 */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { inProcessCore } from "../src/main/core-process/client";
import { core } from "../src/main/core-process/main-client";
import { IPC_CHANNELS, type TerminalParkResult } from "../src/shared/ipc";
import { registerTerminalIpc } from "../src/main/junto/term/ipc";
import type { TermPlane } from "../src/main/junto/term/plane";
import { TerminalNodeDeleteService } from "../src/main/junto/term/node-delete";
import { OBSERVER_WATCHED_SCROLLBACK } from "../src/main/junto/term/observer/session-observer";
import { TERMINAL_BOUNDS } from "../src/shared/settings";

// The terminal ops run on the plane this test binds; they need no service.
const noServices = inProcessCore({ runPromiseExit: (effect) => Effect.runPromiseExit(effect as never) });
const stubCore = () => vi.spyOn(core, "call").mockImplementation(((name: string, input: never) =>
  noServices.call(name as never, input)) as typeof core.call);

type Handler = (...args: readonly unknown[]) => unknown;

const eventually = async (check: () => void, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { return check(); } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
};

const rig = () => {
  const sent: { readonly channel: string; readonly payload: unknown }[] = [];
  const sender = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
  });
  const event = { sender };
  const handlers = new Map<string, Handler>();
  let minted = 0;
  const router = Object.assign(new EventEmitter(), {
    thisMachineName: () => "workbench",
    isLocalHostId: (hostId: string | undefined | null) => !hostId || hostId === "workbench",
    attach: vi.fn(async (input: { bindingId: string; mode: "control" | "observe" }) => ({
      ok: true as const,
      lease: { leaseId: `lease-${(minted += 1)}`, bindingId: input.bindingId, epoch: `epoch-${input.bindingId}`, mode: input.mode },
      cols: 80,
      rows: 24,
      screen: { bindingId: input.bindingId, epoch: `epoch-${input.bindingId}`, cols: 80, rows: 24, seq: 7n, serialized: "grid" },
      journal: [],
      status: "running" as const,
    })),
    release: vi.fn(async () => {}),
    setTerminalEnvironment: vi.fn(),
  });
  stubCore();
  registerTerminalIpc(
    { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as never,
    { router, nodeDelete: new TerminalNodeDeleteService(router as never) } as unknown as TermPlane,
    { isTrustedSender: () => true, broadcast: () => {} },
  );
  const call = (channel: string, ...args: unknown[]) => Promise.resolve(handlers.get(channel)!(event, ...args));
  const open = async (bindingId: string): Promise<string> => {
    const result = (await call(IPC_CHANNELS.terminalAttach, { bindingId, mode: "control", takeover: true })) as {
      lease: { leaseId: string };
    };
    return result.lease.leaseId;
  };
  const park = (leaseId: string, parked: boolean) =>
    call(IPC_CHANNELS.terminalPark, leaseId, parked) as Promise<TerminalParkResult>;
  const emit = (bindingId: string, seq: bigint, data: string) =>
    router.emit("event", { type: "output", bindingId, epoch: `epoch-${bindingId}`, seq, data });
  const outputBytes = (): number =>
    sent
      .filter((entry) => entry.channel === IPC_CHANNELS.terminalEvent)
      .map((entry) => entry.payload as { type: string; data?: string })
      .filter((payload) => payload.type === "output")
      .reduce((total, payload) => total + (payload.data?.length ?? 0), 0);
  return { router, sent, open, park, emit, outputBytes };
};

afterEach(() => vi.restoreAllMocks());

describe("a hidden terminal parks its stream", () => {
  it("sends the renderer the bytes of the visible terminal only, with ten opened and hidden", async () => {
    const view = rig();
    const visible = await view.open("seat-0");
    const hidden: string[] = [];
    for (let index = 1; index <= 10; index += 1) hidden.push(await view.open(`seat-${index}`));
    for (const lease of hidden) await view.park(lease, true);
    expect(visible).toBeDefined();

    const chunk = "x".repeat(1_000);
    for (let round = 1; round <= 5; round += 1) {
      for (let index = 0; index <= 10; index += 1) view.emit(`seat-${index}`, BigInt(round), chunk);
    }
    await eventually(() => expect(view.outputBytes()).toBe(5 * chunk.length));
    await new Promise((resolve) => setTimeout(resolve, 80));
    // One terminal on screen is one terminal's bytes, however many are open.
    expect(view.outputBytes()).toBe(5 * chunk.length);
  });

  it("keeps the lease while parked, and still sends the events that are not output", async () => {
    const view = rig();
    const lease = await view.open("seat");
    await view.park(lease, true);
    view.router.emit("event", { type: "exit", bindingId: "seat", epoch: "epoch-seat", seq: 2n });
    await eventually(() =>
      expect(view.sent.map((entry) => (entry.payload as { type?: string }).type)).toContain("exit"),
    );
    expect(view.router.release).not.toHaveBeenCalled();
  });

  it("catches up a view that missed output from the main grid, through an observe lease it gives back", async () => {
    const view = rig();
    const lease = await view.open("seat");
    await view.park(lease, true);
    view.emit("seat", 1n, "missed");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(view.outputBytes()).toBe(0);

    const result = await view.park(lease, false);
    expect(result).toEqual({
      ok: true,
      missed: true,
      screen: { epoch: "epoch-seat", cols: 80, rows: 24, seq: 7n, serialized: "grid" },
      journal: [],
    });
    expect(view.router.attach).toHaveBeenLastCalledWith({ bindingId: "seat", mode: "observe", hostId: "workbench" });
    expect(view.router.release).toHaveBeenCalledWith(expect.objectContaining({ mode: "observe" }), "workbench");

    // Unparked, output flows again.
    view.emit("seat", 8n, "live");
    await eventually(() => expect(view.outputBytes()).toBe("live".length));
  });

  it("unparks a view that missed nothing without reading the grid", async () => {
    const view = rig();
    const lease = await view.open("seat");
    await view.park(lease, true);
    expect(await view.park(lease, false)).toEqual({ ok: true, missed: false });
    expect(view.router.attach).toHaveBeenCalledTimes(1);
  });

  it("delivers output already batched before the park", async () => {
    const view = rig();
    const lease = await view.open("seat");
    view.emit("seat", 1n, "before");
    await view.park(lease, true);
    expect(view.outputBytes()).toBe("before".length);
  });

  it("refuses a lease this window does not hold", async () => {
    const view = rig();
    expect(await view.park("lease-unknown", true)).toEqual({ ok: false });
  });

  it("keeps a main grid that holds at least the deepest scrollback a terminal can be set to", () => {
    // A parked view keeps its lease, so the main grid stays at the watched
    // tier, and a catch-up gives back no less than xterm would have held.
    expect(OBSERVER_WATCHED_SCROLLBACK).toBeGreaterThanOrEqual(TERMINAL_BOUNDS.scrollback.max);
  });
});
