import { describe, expect, it, vi } from "vitest";
import { createProbeResourceLifecycle } from "../scripts/probe-resource-lifecycle";

describe("probe resource lifecycle", () => {
  it("refuses acquisition after an early shutdown", async () => {
    const start = vi.fn(async () => ({ close: async () => undefined }));
    const lifecycle = createProbeResourceLifecycle("renderer");

    await expect(lifecycle.close()).resolves.toBe(true);
    await expect(lifecycle.acquire(start)).rejects.toThrow(
      "renderer acquisition refused after shutdown began",
    );
    expect(start).not.toHaveBeenCalled();
  });

  it("joins acquisition and closes the resource when shutdown wins the race", async () => {
    let finishStart!: (resource: { readonly close: () => Promise<void> }) => void;
    const pending = new Promise<{ readonly close: () => Promise<void> }>(
      (resolve) => {
        finishStart = resolve;
      },
    );
    const close = vi.fn(async () => undefined);
    const lifecycle = createProbeResourceLifecycle("renderer");

    const acquired = lifecycle.acquire(() => pending);
    const closed = lifecycle.close();
    finishStart({ close });

    await expect(acquired).rejects.toThrow(
      "renderer acquisition canceled by shutdown",
    );
    await expect(closed).resolves.toBe(true);
    expect(close).toHaveBeenCalledOnce();
    await expect(lifecycle.close()).resolves.toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes an acquired resource exactly once and reports close failure", async () => {
    const failure = new Error("close failed");
    const onCloseFailure = vi.fn();
    const close = vi.fn(async () => {
      throw failure;
    });
    const lifecycle = createProbeResourceLifecycle("renderer", onCloseFailure);

    await expect(lifecycle.acquire(async () => ({ close }))).resolves.toEqual({
      close,
    });
    await expect(lifecycle.close()).resolves.toBe(false);
    await expect(lifecycle.close()).resolves.toBe(false);
    expect(close).toHaveBeenCalledOnce();
    expect(onCloseFailure).toHaveBeenCalledExactlyOnceWith(failure);
  });
});
