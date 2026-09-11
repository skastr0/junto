import { createServer, type RequestListener, type Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  makeElectronBrowserReadinessProductPath,
} from "../src/main/vellum-command/browser/readiness-product-path";
import { makeBrowserProductPathProbe } from "../src/main/vellum-command/browser/readiness-probe";
import type {
  BrowserCompositionHost,
  BrowserCompositionHostWindow,
} from "../src/main/vellum-command/browser/composition-host";
import type {
  BrowserViewAdapter,
  BrowserViewHandle,
} from "../src/main/vellum-command/browser/sessions";

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);

const compositionHost = (): BrowserCompositionHost => {
  const window: BrowserCompositionHostWindow = {
    isDestroyed: () => false,
    destroy: () => undefined,
  };
  return {
    current: () => window,
    ensureHeadlessHost: async () => window,
    bindVisibleWindow: async () => undefined,
    releaseVisibleWindow: async () => undefined,
    shutdown: async () => undefined,
  };
};

const viewFixture = (
  capture: Uint8Array = PNG,
  evaluation: unknown = { __vellumEval: 1, status: "ok", json: "true" },
) => {
  const loadUrl = vi.fn(async () => undefined);
  const attach = vi.fn();
  const detach = vi.fn();
  const stopLoading = vi.fn();
  const destroy = vi.fn();
  const handle: BrowserViewHandle = {
    loadUrl,
    attach,
    setBounds: vi.fn(),
    detach,
    stopLoading,
    destroy,
    whenDestroyed: async () => undefined,
    executeJavaScript: async () => evaluation,
    capturePagePng: async () => capture,
  };
  const adapter = vi.fn(() => handle) as unknown as BrowserViewAdapter;
  return { adapter, loadUrl, attach, detach, stopLoading, destroy };
};

const openPage = async (
  path: ReturnType<typeof makeElectronBrowserReadinessProductPath>,
  signal: AbortSignal,
) => {
  const origin = path.loopbackOrigin();
  return path.openSyntheticLoopbackPage({
    url: `${origin}vellum-readiness?nonce=test`,
    signal,
  });
};

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe("Electron browser readiness product path", () => {
  it("can prove two sequential Doctor assessments with fresh owned runs", async () => {
    const view = viewFixture();
    const path = makeElectronBrowserReadinessProductPath({
      compositionHost: compositionHost(),
      viewAdapter: view.adapter,
      createNonce: () => "partition",
    });

    for (let index = 0; index < 2; index += 1) {
      const controller = new AbortController();
      await expect(path.ensureCompositionHost(controller.signal)).resolves.toBe(true);
      const page = await openPage(path, controller.signal);
      await expect(page.navigate(controller.signal)).resolves.toBe(true);
      await expect(page.evaluate(controller.signal)).resolves.toBe(true);
      await expect(page.screenshot(controller.signal)).resolves.toBe(true);
      await page.close();
      expect(() => path.loopbackOrigin()).toThrow(/unavailable/u);
    }

    expect(view.adapter).toHaveBeenCalledTimes(2);
    expect(view.destroy).toHaveBeenCalledTimes(2);
  });

  it("rejects a nonempty screenshot that is not a PNG receipt", async () => {
    const view = viewFixture(Uint8Array.from([0x01, 0x02, 0x03]));
    const path = makeElectronBrowserReadinessProductPath({
      compositionHost: compositionHost(),
      viewAdapter: view.adapter,
    });
    const controller = new AbortController();

    await expect(path.ensureCompositionHost(controller.signal)).resolves.toBe(true);
    const page = await openPage(path, controller.signal);
    await expect(page.screenshot(controller.signal)).resolves.toBe(false);
    await page.close();
  });

  it("cannot turn a swallowed navigation failure plus blank-page PNG into ready", async () => {
    const view = viewFixture(PNG, {
      __vellumEval: 1,
      status: "ok",
      json: "false",
    });
    const productPath = makeElectronBrowserReadinessProductPath({
      compositionHost: compositionHost(),
      viewAdapter: view.adapter,
    });
    const probe = makeBrowserProductPathProbe({
      station: () => ({
        role: "remote",
        hostId: "studio",
        browserCapabilityDeclared: true,
        controlReady: true,
        controlHostId: "studio",
        registeredRemoteHostId: "studio",
        sandboxReady: true,
        displayReady: true,
      }),
      productPath,
    });

    await expect(probe.probe(new AbortController().signal)).resolves.toMatchObject({
      transport: "failed",
    });
    expect(view.loadUrl).toHaveBeenCalledTimes(1);
    expect(view.destroy).toHaveBeenCalledTimes(1);
  });

  it("cancels the exact pending loopback bind and remains reusable", async () => {
    const observed: Server[] = [];
    const observedCreateServer = ((listener: RequestListener) => {
      const server = createServer(listener);
      observed.push(server);
      return server;
    }) as typeof createServer;
    const path = makeElectronBrowserReadinessProductPath({
      compositionHost: compositionHost(),
      viewAdapter: viewFixture().adapter,
      createServer: observedCreateServer,
    });
    const cancelled = new AbortController();

    const pending = path.ensureCompositionHost(cancelled.signal);
    cancelled.abort("test cancellation");
    await expect(pending).resolves.toBe(false);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(observed).toHaveLength(1);
    expect(observed[0]!.listening).toBe(false);
    expect(observed[0]!.address()).toBeNull();
    expect(() => path.loopbackOrigin()).toThrow(/unavailable/u);

    const retry = new AbortController();
    await expect(path.ensureCompositionHost(retry.signal)).resolves.toBe(true);
    await path.close();
    expect(observed).toHaveLength(2);
    expect(observed[1]!.listening).toBe(false);
  });

  it("awaits an already-started listener cleanup after abort clears the active run", async () => {
    const closeRequested = deferred<void>();
    const releaseClose = deferred<void>();
    const delayedCreateServer = ((listener: RequestListener) => {
      const server = createServer(listener);
      const originalClose = server.close.bind(server);
      server.close = ((callback?: (error?: Error) => void) => {
        closeRequested.resolve();
        void releaseClose.promise.then(() => {
          originalClose(callback ?? (() => undefined));
        });
        return server;
      }) as Server["close"];
      return server;
    }) as typeof createServer;
    const path = makeElectronBrowserReadinessProductPath({
      compositionHost: compositionHost(),
      viewAdapter: viewFixture().adapter,
      createServer: delayedCreateServer,
    });
    const controller = new AbortController();

    const ensure = path.ensureCompositionHost(controller.signal);
    controller.abort("test cancellation");
    await closeRequested.promise;

    let closeSettled = false;
    const close = path.close().then(() => {
      closeSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closeSettled).toBe(false);

    releaseClose.resolve();
    await close;
    await expect(ensure).resolves.toBe(false);
  });

  it("aborting an open page destroys its exact view and listener", async () => {
    const view = viewFixture();
    const path = makeElectronBrowserReadinessProductPath({
      compositionHost: compositionHost(),
      viewAdapter: view.adapter,
    });
    const controller = new AbortController();

    await expect(path.ensureCompositionHost(controller.signal)).resolves.toBe(true);
    const page = await openPage(path, controller.signal);
    controller.abort("test cancellation");
    await page.close();

    expect(view.stopLoading).toHaveBeenCalledTimes(1);
    expect(view.detach).toHaveBeenCalledTimes(1);
    expect(view.destroy).toHaveBeenCalledTimes(1);
    expect(() => path.loopbackOrigin()).toThrow(/unavailable/u);
  });
});
