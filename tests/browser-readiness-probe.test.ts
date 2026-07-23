import { describe, expect, it, vi } from "vitest";
import { makeBrowserProductPathProbe } from "../src/main/vellum/browser/readiness-probe";

const station = (overrides: Partial<ReturnType<typeof facts>> = {}) => () => ({ ...facts(), ...overrides });
const facts = () => ({ role: "remote", hostId: "studio", browserCapabilityDeclared: true, controlReady: true, controlHostId: "studio", registeredRemoteHostId: "studio", sandboxReady: true, displayReady: true });
const signal = () => new AbortController().signal;

const product = () => {
  const close = vi.fn(async () => undefined);
  const closePath = vi.fn(async () => undefined);
  return {
    close,
    closePath,
    path: {
      ensureCompositionHost: vi.fn(async () => true),
      loopbackOrigin: () => "http://127.0.0.1:49152/",
      openSyntheticLoopbackPage: vi.fn(async () => ({
        navigate: async () => true,
        evaluate: async () => true,
        screenshot: async () => true,
        close,
      })),
      close: closePath,
    },
  };
};

describe("browser product-path readiness probe", () => {
  it("proves composition plus synthetic navigation, evaluation, screenshot, and cleanup", async () => {
    const value = product();
    const receipt = await makeBrowserProductPathProbe({ station: station(), productPath: value.path, createNonce: () => "nonce" }).probe(signal());

    expect(receipt).toEqual({ version: 1, hostId: "studio", transport: "ready", composition: "ready", display: "ready", sandbox: "ready", capability: "ready" });
    expect(value.path.openSyntheticLoopbackPage).toHaveBeenCalledWith(expect.objectContaining({ url: "http://127.0.0.1:49152/vellum-readiness?nonce=nonce" }));
    expect(value.close).toHaveBeenCalledTimes(1);
    expect(value.closePath).toHaveBeenCalledTimes(1);
  });

  it("does not expose a browser path when role, capability, display, sandbox, or control is not current", async () => {
    for (const override of [
      { role: "command-center" }, { browserCapabilityDeclared: false }, { registeredRemoteHostId: "other" }, { displayReady: false }, { sandboxReady: false }, { controlReady: false }, { controlHostId: "other" },
    ]) {
      const value = product();
      const receipt = await makeBrowserProductPathProbe({ station: station(override), productPath: value.path }).probe(signal());
      expect(receipt).not.toMatchObject({
        transport: "ready", composition: "ready", display: "ready", sandbox: "ready", capability: "ready",
      });
      expect(value.path.openSyntheticLoopbackPage).not.toHaveBeenCalled();
    }
  });

  it("joins callers and cleans up once when the synthetic path fails", async () => {
    const close = vi.fn(async () => undefined);
    let resolve!: (value: boolean) => void;
    const pending = new Promise<boolean>((done) => { resolve = done; });
    const openSyntheticLoopbackPage = vi.fn(async () => ({ navigate: async () => pending, evaluate: async () => true, screenshot: async () => true, close }));
    const probe = makeBrowserProductPathProbe({ station: station(), productPath: { ensureCompositionHost: async () => true, loopbackOrigin: () => "http://127.0.0.1:49152/", openSyntheticLoopbackPage, close: async () => undefined } });
    const first = probe.probe(signal());
    const second = probe.probe(signal());
    resolve(false);
    await expect(Promise.all([first, second])).resolves.toEqual([expect.objectContaining({ transport: "failed" }), expect.objectContaining({ transport: "failed" })]);
    expect(openSyntheticLoopbackPage).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("releases the one-flight after cleanup so a later Doctor probe runs again", async () => {
    const value = product();
    const probe = makeBrowserProductPathProbe({
      station: station(),
      productPath: value.path,
    });

    await expect(probe.probe(signal())).resolves.toMatchObject({ transport: "ready" });
    await expect(probe.probe(signal())).resolves.toMatchObject({ transport: "ready" });

    expect(value.path.ensureCompositionHost).toHaveBeenCalledTimes(2);
    expect(value.path.openSyntheticLoopbackPage).toHaveBeenCalledTimes(2);
    expect(value.close).toHaveBeenCalledTimes(2);
    expect(value.closePath).toHaveBeenCalledTimes(2);
  });

  it("fails closed when station authority changes during the synthetic path", async () => {
    let current = facts();
    const value = product();
    value.path.openSyntheticLoopbackPage.mockImplementation(async () => ({
      navigate: async () => true,
      evaluate: async () => true,
      screenshot: async () => {
        current = { ...current, controlReady: false };
        return true;
      },
      close: value.close,
    }));
    const probe = makeBrowserProductPathProbe({
      station: () => current,
      productPath: value.path,
    });

    await expect(probe.probe(signal())).resolves.toMatchObject({
      transport: "failed",
      composition: "failed",
      capability: "failed",
    });
    expect(value.close).toHaveBeenCalledOnce();
    expect(value.closePath).toHaveBeenCalledOnce();
  });

  it("fails closed and aborts a bounded synthetic operation", async () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => undefined);
    const probe = makeBrowserProductPathProbe({
      timeoutMs: 5,
      station: station(),
      productPath: { ensureCompositionHost: async () => true, loopbackOrigin: () => "http://127.0.0.1:49152/", openSyntheticLoopbackPage: async () => ({ navigate: async () => new Promise<boolean>(() => undefined), evaluate: async () => true, screenshot: async () => true, close }), close: async () => undefined },
    });
    const result = probe.probe(signal());
    await vi.advanceTimersByTimeAsync(5);
    await expect(result).resolves.toMatchObject({ transport: "failed" });
    expect(close).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
