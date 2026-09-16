import { describe, expect, it, vi } from "vitest";
import {
  HIDDEN_COMPOSITION_HOST_WINDOW_OPTIONS,
  makeBrowserCompositionHost,
  type BrowserCompositionHostWindow,
} from "../src/main/junto/browser/composition-host";

const window = (name: string, events: string[]): BrowserCompositionHostWindow & { destroyed: boolean } => {
  const result = {
    destroyed: false,
    isDestroyed: () => result.destroyed,
    destroy: () => {
      events.push(`${name}:destroy`);
      result.destroyed = true;
    },
  };
  return result;
};

describe("browser composition host", () => {
  it("defines a hidden, unfocusable, renderer-free host configuration", () => {
    expect(HIDDEN_COMPOSITION_HOST_WINDOW_OPTIONS).toEqual({
      show: false,
      focusable: false,
      skipTaskbar: true,
      webPreferences: {
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
      },
    });
    expect("preload" in HIDDEN_COMPOSITION_HOST_WINDOW_OPTIONS.webPreferences).toBe(false);
  });

  it("creates exactly one headless host and binds it before composition readiness", async () => {
    const events: string[] = [];
    const hidden = window("hidden", events);
    const createHiddenWindow = vi.fn((options) => {
      events.push(`create:${String(options.show)}:${String(options.focusable)}`);
      return hidden;
    });
    const host = makeBrowserCompositionHost({
      createHiddenWindow,
      views: {
        detach: () => { events.push("views:detach"); },
        rebind: (target) => { events.push(target === hidden ? "views:bind:hidden" : "views:bind:other"); },
      },
    });

    await expect(host.ensureHeadlessHost()).resolves.toBe(hidden);
    await expect(host.ensureHeadlessHost()).resolves.toBe(hidden);

    expect(createHiddenWindow).toHaveBeenCalledOnce();
    expect(createHiddenWindow).toHaveBeenCalledWith(HIDDEN_COMPOSITION_HOST_WINDOW_OPTIONS);
    expect(events).toEqual(["create:false:false", "views:detach", "views:bind:hidden"]);
    expect(host.current()).toBe(hidden);
  });

  it("rebinds close/recreate deterministically and destroys the former hidden host only after detach", async () => {
    const events: string[] = [];
    const hidden = window("hidden", events);
    const returnedHidden = window("returned-hidden", events);
    const first = window("first", events);
    const replacement = window("replacement", events);
    const hiddenWindows = [hidden, returnedHidden];
    const host = makeBrowserCompositionHost({
      createHiddenWindow: () => {
        const next = hiddenWindows.shift();
        if (next === undefined) throw new Error("unexpected hidden host creation");
        return next;
      },
      views: {
        detach: () => { events.push("views:detach"); },
        rebind: (target) => { events.push(target === first ? "views:bind:first" : target === replacement ? "views:bind:replacement" : "views:bind:hidden"); },
      },
    });

    await host.ensureHeadlessHost();
    await host.bindVisibleWindow(first);
    await host.releaseVisibleWindow(first);
    await host.bindVisibleWindow(replacement);

    expect(events).toEqual([
      "views:detach",
      "views:bind:hidden",
      "views:detach",
      "views:bind:first",
      "hidden:destroy",
      "views:detach",
      "views:bind:hidden",
      "views:detach",
      "views:bind:replacement",
      "returned-hidden:destroy",
    ]);
    expect(host.current()).toBe(replacement);
    expect(first.destroyed).toBe(false);
  });

  it("does not let a stale close release a newer visible composition host", async () => {
    const events: string[] = [];
    const first = window("first", events);
    const second = window("second", events);
    const host = makeBrowserCompositionHost({
      createHiddenWindow: () => window("hidden", events),
      views: { detach: () => { events.push("views:detach"); }, rebind: () => { events.push("views:bind"); } },
    });

    await host.bindVisibleWindow(first);
    await host.bindVisibleWindow(second);
    await host.releaseVisibleWindow(first);

    expect(host.current()).toBe(second);
    expect(events).toEqual(["views:detach", "views:bind", "views:detach", "views:bind"]);
  });

  it("serializes concurrent transitions and rejects destroyed hosts", async () => {
    const events: string[] = [];
    const first = window("first", events);
    const second = window("second", events);
    const destroyed = window("destroyed", events);
    destroyed.destroyed = true;
    const host = makeBrowserCompositionHost({
      createHiddenWindow: () => window("hidden", events),
      views: { detach: () => { events.push("views:detach"); }, rebind: (target) => { events.push(target === first ? "views:bind:first" : "views:bind:second"); } },
    });

    await Promise.all([host.bindVisibleWindow(first), host.bindVisibleWindow(second)]);
    await expect(host.bindVisibleWindow(destroyed)).rejects.toThrow("destroyed visible");

    expect(events).toEqual(["views:detach", "views:bind:first", "views:detach", "views:bind:second"]);
    expect(host.current()).toBe(second);
  });

  it("has one idempotent bounded shutdown that detaches before destroying only its hidden host", async () => {
    const events: string[] = [];
    const hidden = window("hidden", events);
    const host = makeBrowserCompositionHost({
      createHiddenWindow: () => hidden,
      views: { detach: () => { events.push("views:detach"); }, rebind: () => { events.push("views:bind"); } },
    });
    await host.ensureHeadlessHost();

    const first = host.shutdown();
    const concurrent = host.shutdown();
    expect(concurrent).toBe(first);
    await first;

    expect(events).toEqual(["views:detach", "views:bind", "views:detach", "hidden:destroy"]);
    expect(host.current()).toBeUndefined();
  });

  it("still destroys its owned hidden host if view detachment fails", async () => {
    const events: string[] = [];
    const hidden = window("hidden", events);
    const detach = vi.fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("detach failed");
      });
    const host = makeBrowserCompositionHost({
      createHiddenWindow: () => hidden,
      views: { detach, rebind: () => undefined },
    });
    await host.ensureHeadlessHost();

    await expect(host.shutdown()).rejects.toThrow("detach failed");
    expect(hidden.destroyed).toBe(true);
    expect(host.current()).toBeUndefined();
  });
});
