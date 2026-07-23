/**
 * Private synthetic browser path used only by station readiness.
 *
 * It owns an ephemeral loopback listener and one in-memory WebContentsView.
 * Nothing here enters the browser control plane, profile registry, canvas, or
 * capability registry.
 */

import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { BrowserCompositionHost } from "./composition-host";
import type { BrowserViewAdapter, BrowserViewEvents, BrowserViewHandle } from "./sessions";
import type {
  BrowserReadinessProductPath,
  BrowserReadinessSyntheticPage,
} from "./readiness-probe";

const SYNTHETIC_BODY = "<!doctype html><title>Vellum readiness</title><main>ready</main>";

export interface BrowserReadinessProductPathDependencies {
  readonly compositionHost: BrowserCompositionHost;
  readonly viewAdapter: BrowserViewAdapter;
  readonly createNonce?: () => string;
  readonly createServer?: typeof createServer;
}

const listenLoopback = (server: Server): Promise<string> =>
  new Promise((resolve, reject) => {
    const fail = (error: Error): void => {
      server.removeListener("listening", ready);
      reject(error);
    };
    const ready = (): void => {
      server.removeListener("error", fail);
      const address = server.address();
      if (address === null || typeof address === "string" || address.address !== "127.0.0.1") {
        reject(new Error("readiness listener did not bind exact loopback"));
        return;
      }
      resolve(`http://127.0.0.1:${String(address.port)}/`);
    };
    server.once("error", fail);
    server.once("listening", ready);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true });
  });

const closeServer = (server: Server | undefined): Promise<void> =>
  server === undefined || !server.listening
    ? Promise.resolve()
    : new Promise((resolve) => server.close(() => resolve()));

const readinessEvents = (): BrowserViewEvents => ({
  onNavigationStart: (event) => event.expectedSessionId ?? "readiness",
  onNavigationAmbiguous: () => undefined,
  onNavigationUrl: () => undefined,
  onLoadOk: () => undefined,
  onLoadFail: () => undefined,
  onUnexpectedTermination: () => undefined,
});

const successfulEval = (value: unknown): boolean =>
  typeof value === "object" && value !== null &&
  "__vellumEval" in value && "status" in value &&
  value.__vellumEval === 1 && value.status === "ok";

/**
 * Constructs the composition-owned readiness port. `close` is deliberately
 * unconditional: a listener opened before view construction cannot outlive a
 * failed open or cancelled probe.
 */
export const makeElectronBrowserReadinessProductPath = (
  dependencies: BrowserReadinessProductPathDependencies,
): BrowserReadinessProductPath => {
  const createNonce = dependencies.createNonce ?? randomUUID;
  const createHttpServer = dependencies.createServer ?? createServer;
  let server: Server | undefined;
  let origin: string | undefined;
  let closed = false;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const current = server;
    server = undefined;
    origin = undefined;
    await closeServer(current);
  };

  return Object.freeze({
    ensureCompositionHost: async (signal: AbortSignal): Promise<boolean> => {
      if (signal.aborted || closed) return false;
      try {
        if (dependencies.compositionHost.current() === undefined) {
          await dependencies.compositionHost.ensureHeadlessHost();
        }
        if (signal.aborted || dependencies.compositionHost.current() === undefined) return false;
        if (origin !== undefined) return true;
        const candidate = createHttpServer((_request, response) => {
          response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
          });
          response.end(SYNTHETIC_BODY);
        });
        server = candidate;
        origin = await listenLoopback(candidate);
        return !signal.aborted;
      } catch {
        await close();
        return false;
      }
    },
    loopbackOrigin: (): string => {
      if (origin === undefined || closed) throw new Error("readiness loopback listener is unavailable");
      return origin;
    },
    openSyntheticLoopbackPage: async (
      { url, signal }: Readonly<{ url: string; signal: AbortSignal }>,
    ): Promise<BrowserReadinessSyntheticPage> => {
      if (signal.aborted || origin === undefined || closed || !url.startsWith(origin)) {
        throw new Error("readiness page requested without its exact loopback origin");
      }
      const partition = `vellum-readiness-${createNonce()}`;
      let view: BrowserViewHandle | undefined;
      let pageClosed = false;
      const closePage = async (): Promise<void> => {
        if (pageClosed) return;
        pageClosed = true;
        try {
          view?.detach();
          view?.destroy();
          await view?.whenDestroyed?.();
        } finally {
          await close();
        }
      };
      try {
        view = dependencies.viewAdapter(partition, readinessEvents(), { exactTopLevelOrigin: origin });
        view.attach({ x: 0, y: 0, width: 1, height: 1 });
        return Object.freeze({
          navigate: async (operationSignal: AbortSignal): Promise<boolean> => {
            if (operationSignal.aborted || pageClosed) return false;
            await view!.loadUrl(url, "readiness");
            return !operationSignal.aborted;
          },
          evaluate: async (operationSignal: AbortSignal): Promise<boolean> => {
            if (operationSignal.aborted || pageClosed || view!.executeJavaScript === undefined) return false;
            return successfulEval(await view!.executeJavaScript("document.title === 'Vellum readiness'"));
          },
          screenshot: async (operationSignal: AbortSignal): Promise<boolean> => {
            if (operationSignal.aborted || pageClosed || view!.capturePagePng === undefined) return false;
            return (await view!.capturePagePng()).byteLength > 0;
          },
          close: closePage,
        });
      } catch (error) {
        await closePage();
        throw error;
      }
    },
    close,
  });
};
