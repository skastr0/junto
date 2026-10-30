import { Effect, Layer, ManagedRuntime } from "effect";
import { expect, it, vi } from "vitest";
import { inProcessCore, type CoreRunner } from "../src/main/core-process/client";
import { coreSurfacePlane, openCoreSurface, SURFACE_OPENED, type SurfaceOpenMessage } from "../src/main/core-process/ops/term-surface";
import { termPlane } from "../src/main/junto/term/plane";

// Plan B: a view's surface port rides from main to the core's plane, which says whether it opened.
it("carries a surface port to the core's plane, answers whether it opened, and closes it by name", async () => {
  const runtime = ManagedRuntime.make(Layer.empty);
  const core = inProcessCore(runtime as unknown as CoreRunner);
  const pushes = new Map<string, (payload: unknown) => void>();
  const opened: Array<[string, bigint | undefined]> = [];
  const stopped: string[] = [];
  const open = vi.spyOn(termPlane.host, "openSurface").mockImplementation((lease, port, options) => {
    if (lease.mode !== "control") {
      port.close();
      return undefined;
    }
    opened.push([lease.leaseId, options?.read]);
    return () => void stopped.push(lease.leaseId);
  });
  const close = vi.spyOn(termPlane.host, "closeSurface").mockImplementation(() => undefined);
  const plane = coreSurfacePlane({
    // The core process's side, as entry.ts runs it on the transferred port.
    postSurface: (message: SurfaceOpenMessage, port) => {
      queueMicrotask(() => openCoreSurface(message, port as { close: () => void }, (channel, payload) => pushes.get(channel)?.(payload)));
      return true;
    },
    onPush: (channel, listener) => (pushes.set(channel, listener), () => pushes.delete(channel)),
    call: (name, input) => core.call(name, input),
  });
  try {
    const port = { close: vi.fn() };
    const lease = { leaseId: "l1", bindingId: "b", epoch: "e", mode: "control" } as never;
    const stop = await plane.open(lease, port, 7n);
    expect(stop).toBeDefined();
    expect(opened).toEqual([["l1", 7n]]);
    stop!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopped).toEqual(["l1"]);
    expect(close).toHaveBeenCalledOnce();

    const observePort = { close: vi.fn() };
    expect(await plane.open({ leaseId: "l2", bindingId: "b", epoch: "e", mode: "observe" } as never, observePort)).toBeUndefined();
    expect(observePort.close).toHaveBeenCalledOnce();

    const noCore = coreSurfacePlane({ postSurface: () => false, onPush: () => () => undefined, call: () => Effect.runPromise(Effect.void) });
    const unsent = { close: vi.fn() };
    expect(await noCore.open(lease, unsent)).toBeUndefined();
    expect(unsent.close).toHaveBeenCalledOnce();
    expect(pushes.has(SURFACE_OPENED)).toBe(true);
  } finally {
    open.mockRestore();
    close.mockRestore();
    await runtime.dispose();
  }
});
