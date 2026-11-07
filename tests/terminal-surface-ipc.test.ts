/**
 * A control view that takes a surface port (phase 3): main hands it a port
 * for its lease and sends it no output over IPC while it holds one, since
 * the port carries it. Hidden, the view gives the port up; shown again it
 * repaints from the grid and gets a new port that starts after that screen.
 * A view whose PTY is not in the terminal process reads over IPC as before,
 * and a view that did not ask never gets a port.
 */
import { EventEmitter } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS, type TerminalParkResult } from "../src/shared/ipc";
import type { TermPlane } from "../src/core/term/plane";
import type { SurfacePlane } from "../src/app/core-process/main-side/term-surface";
import { TerminalNodeDeleteService } from "../src/core/term/node-delete";
import { Layer, ManagedRuntime } from "effect";
import { RpcTest } from "effect/rpc";
import { TermCore, TermRpcs } from "../src/contract/core/term-ipc";
import { TermTemplatesCore, TermTemplatesRpcs } from "../src/contract/core/term-templates";
import { bindTermIpcPlane, TermIpcPlane, TermPlaneHandlers } from "../src/core/ops/term-ipc";
import { TermTemplatesHandlers } from "../src/core/ops/term-templates";
import { ModelService } from "../src/core/model/service";

vi.mock("electron", () => ({ MessageChannelMain: MessageChannel }));
vi.mock("../src/app/runtime", () => ({ AppRuntime: ManagedRuntime.make(Layer.empty) }));

const { registerTerminalIpc } = await import("../src/app/term/ipc");

// The handlers on the test's plane and model. A handler that reads a service
// this test does not give fails when it is asked; none of those is asked here.
const termHandlers = TermPlaneHandlers as never as Layer.Layer<
  Layer.Success<typeof TermPlaneHandlers>,
  never,
  TermIpcPlane | ModelService
>;

const runtimes: Array<ManagedRuntime.ManagedRuntime<TermCore | TermTemplatesCore, never>> = [];

// The window's handlers ask the core's terminal group; here the core is in
// process, its handlers on the rig's plane.
const termCore = (plane: Pick<TermPlane, "router" | "nodeDelete" | "host">) => {
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.effect(TermCore, RpcTest.makeClient(TermRpcs)),
      Layer.effect(TermTemplatesCore, RpcTest.makeClient(TermTemplatesRpcs)),
    ).pipe(
      Layer.provide(Layer.mergeAll(termHandlers, TermTemplatesHandlers)),
      Layer.provide(Layer.succeed(TermIpcPlane, plane)),
      Layer.provide(Layer.succeed(ModelService, {} as never)),
    ),
  );
  runtimes.push(runtime);
  return runtime.context();
};

type Handler = (...args: readonly unknown[]) => unknown;

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

const rig = async (surfaces: boolean | (() => boolean) = true) => {
  const during: Array<() => void> = [];
  const sent: { readonly channel: string; readonly payload: unknown }[] = [];
  const ports: { readonly leaseId: string }[] = [];
  const sender = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
    postMessage: (channel: string, payload: { leaseId: string }, transfer: readonly MessagePort[]) => {
      expect(channel).toBe(IPC_CHANNELS.terminalSurface);
      expect(transfer).toHaveLength(1);
      ports.push(payload);
      for (const port of transfer) port.close();
    },
  });
  const handlers = new Map<string, Handler>();
  let minted = 0;
  const router = Object.assign(new EventEmitter(), {
    thisMachineName: () => "workbench",
    isLocalHostId: (hostId: string | undefined | null) => !hostId || hostId === "workbench",
    attach: vi.fn(async (input: { bindingId: string; mode: "control" | "observe" }) => {
      // An unpark reads the screen through an observe lease; output can flow meanwhile.
      if (input.mode === "observe") for (const step of during.splice(0)) step();
      await settle();
      return {
      ok: true as const,
      lease: { leaseId: `lease-${(minted += 1)}`, bindingId: input.bindingId, epoch: "e1", mode: input.mode },
      cols: 80,
      rows: 24,
      screen: { bindingId: input.bindingId, epoch: "e1", cols: 80, rows: 24, seq: 9n, serialized: "grid" },
      journal: [],
      status: "running" as const,
      };
    }),
    release: vi.fn(async () => {}),
    setTerminalEnvironment: vi.fn(),
  });
  const stops: Array<ReturnType<typeof vi.fn>> = [];
  const host = {
    openSurface: vi.fn((_lease: unknown, port: { close: () => void }, _options?: { read?: bigint }) => {
      if (!(typeof surfaces === "function" ? surfaces() : surfaces)) {
        port.close();
        return undefined;
      }
      const stop = vi.fn();
      stops.push(stop);
      return stop;
    }),
    closeSurface: vi.fn(),
  };
  const plane = { router, host, nodeDelete: new TerminalNodeDeleteService(router as never) } as unknown as TermPlane;
  unbind = bindTermIpcPlane(plane);
  // Main's surface ports reach the core: here the core is the same process, and
  // this stands in for its plane handing the port to the terminal process.
  const surfacePlane: SurfacePlane = {
    open: async (lease, port, read) =>
      host.openSurface(lease, port, read === undefined ? undefined : { read }),
  };
  registerTerminalIpc(
    { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as never,
    { isTrustedSender: () => true, broadcast: () => {}, surfacePlane: () => surfacePlane },
    await termCore(plane),
  );
  const call = (channel: string, ...args: unknown[]) => Promise.resolve(handlers.get(channel)!({ sender }, ...args));
  const open = async (surface = true): Promise<string> => {
    const result = (await call(IPC_CHANNELS.terminalAttach, { bindingId: "seat", mode: "control", takeover: true, surface })) as {
      lease: { leaseId: string };
    };
    return result.lease.leaseId;
  };
  const park = (leaseId: string, parked: boolean) => call(IPC_CHANNELS.terminalPark, leaseId, parked) as Promise<TerminalParkResult>;
  const emit = (seq: bigint, data: string) => router.emit("event", { type: "output", bindingId: "seat", epoch: "e1", seq, data });
  const output = () =>
    sent.filter((entry) => entry.channel === IPC_CHANNELS.terminalEvent && (entry.payload as { type: string }).type === "output");
  return { host, stops, ports, open, park, emit, output, router, sent, during };
};

let unbind: (() => void) | undefined;
afterEach(async () => {
  unbind?.();
  unbind = undefined;
  vi.restoreAllMocks();
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
});

describe("a control view on a surface port", () => {
  it("gets a port for its lease and no output over IPC while it holds it", async () => {
    const view = await rig();
    const lease = await view.open();
    expect(view.ports).toEqual([{ leaseId: lease }]);
    view.emit(10n, "over the port");
    view.router.emit("event", { type: "exit", bindingId: "seat", epoch: "e1", seq: 11n });
    await settle();
    expect(view.output()).toEqual([]);
    // Events that are not output still reach it.
    expect(view.sent.map((entry) => (entry.payload as { type?: string }).type)).toContain("exit");
  });

  it("gives the port up when hidden and gets one that starts after the repainted screen when shown", async () => {
    const view = await rig();
    const lease = await view.open();
    await view.park(lease, true);
    // The view's port is given up by its own stop, which closes it in the core.
    expect(view.stops[0]).toHaveBeenCalledTimes(1);
    view.emit(10n, "while hidden");
    await settle();
    expect(view.output()).toEqual([]);
    const shown = await view.park(lease, false);
    expect(shown).toMatchObject({ ok: true, missed: true, screen: { seq: 9n, serialized: "grid" } });
    expect(view.ports).toHaveLength(2);
    expect(view.host.openSurface.mock.calls.at(-1)?.[2]).toMatchObject({ read: 9n });
    view.emit(12n, "after");
    await settle();
    expect(view.output()).toEqual([]);
  });

  it("a view whose new port does not open still gets the output that flowed while its screen was read", async () => {
    let opens = 0;
    const view = await rig(() => (opens += 1) === 1);
    const lease = await view.open();
    await view.park(lease, true);
    view.during.push(() => view.emit(10n, "during the read"));
    const shown = await view.park(lease, false);
    expect(shown).toMatchObject({ ok: true, missed: true, screen: { seq: 9n } });
    expect(view.ports).toHaveLength(1);
    await settle();
    expect(view.output().map((entry) => (entry.payload as { data: string }).data).join("")).toContain("during the read");
    view.emit(11n, "after");
    await settle();
    expect(view.output().map((entry) => (entry.payload as { data: string }).data).join("")).toContain("after");
  });

  it("a view hidden again while its screen was read gets no port until it is shown", async () => {
    const view = await rig();
    const lease = await view.open();
    await view.park(lease, true);
    let parkedAgain: Promise<unknown> | undefined;
    view.during.push(() => {
      parkedAgain = view.park(lease, true);
    });
    await view.park(lease, false);
    await parkedAgain;
    expect(view.ports).toHaveLength(1);
    view.emit(10n, "while hidden");
    await settle();
    expect(view.output()).toEqual([]);
    expect(await view.park(lease, false)).toMatchObject({ ok: true, missed: true, screen: { seq: 9n } });
    expect(view.ports).toHaveLength(2);
  });

  it("reads over IPC when its PTY is not in the terminal process", async () => {
    const view = await rig(false);
    await view.open();
    expect(view.ports).toEqual([]);
    view.emit(10n, "over ipc");
    await settle();
    expect(view.output()).toHaveLength(1);
  });

  it("never gets a port it did not ask for", async () => {
    const view = await rig();
    await view.open(false);
    expect(view.host.openSurface).not.toHaveBeenCalled();
    view.emit(10n, "over ipc");
    await settle();
    expect(view.output()).toHaveLength(1);
  });
});
