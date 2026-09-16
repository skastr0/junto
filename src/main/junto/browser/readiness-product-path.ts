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

const SYNTHETIC_BODY = "<!doctype html><title>Junto readiness</title><main>ready</main>";
const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface BrowserReadinessProductPathDependencies {
  readonly compositionHost: BrowserCompositionHost;
  readonly viewAdapter: BrowserViewAdapter;
  readonly createNonce?: () => string;
  readonly createServer?: typeof createServer;
}

const listenLoopback = (server: Server): Promise<string> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      server.removeListener("error", fail);
      server.removeListener("listening", ready);
      server.removeListener("close", closed);
    };
    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const fail = (error: Error): void => {
      rejectOnce(error);
    };
    const ready = (): void => {
      const address = server.address();
      if (address === null || typeof address === "string" || address.address !== "127.0.0.1") {
        rejectOnce(new Error("readiness listener did not bind exact loopback"));
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      resolve(`http://127.0.0.1:${String(address.port)}/`);
    };
    const closed = (): void => {
      rejectOnce(new Error("readiness listener closed before binding"));
    };
    server.once("error", fail);
    server.once("listening", ready);
    server.once("close", closed);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true });
  });

/**
 * `server.listening` remains false during an in-flight `listen()`. Calling
 * close in that window is still required: Node cancels the pending bind and
 * emits `close`. The callback also settles when the server never reached the
 * listening state, so neither path can leave the readiness promise hanging.
 */
const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      server.removeListener("close", done);
      resolve();
    };
    server.once("close", done);
    try {
      server.close(() => done());
    } catch {
      done();
    }
  });

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
  "__juntoEval" in value && "status" in value && "json" in value &&
  value.__juntoEval === 1 && value.status === "ok" && value.json === "true";

const hasPngSignature = (value: Uint8Array): boolean =>
  value.byteLength >= PNG_SIGNATURE.byteLength &&
  PNG_SIGNATURE.every((byte, index) => value[index] === byte);

interface ListenerRun {
  readonly server: Server;
  readonly listen: Promise<string>;
  origin?: string;
  closeFlight?: Promise<void>;
  closePage?: () => Promise<void>;
}

/**
 * Constructs the reusable composition-owned readiness port. Every assessment
 * gets a fresh listener/run, while `close` always targets the exact active run.
 */
export const makeElectronBrowserReadinessProductPath = (
  dependencies: BrowserReadinessProductPathDependencies,
): BrowserReadinessProductPath => {
  const createNonce = dependencies.createNonce ?? randomUUID;
  const createHttpServer = dependencies.createServer ?? createServer;
  let active: ListenerRun | undefined;
  const cleanupFlights = new Set<Promise<void>>();

  const trackCleanup = (flight: Promise<void>): Promise<void> => {
    cleanupFlights.add(flight);
    void flight.then(
      () => cleanupFlights.delete(flight),
      () => cleanupFlights.delete(flight),
    );
    return flight;
  };

  const closeRun = (run: ListenerRun): Promise<void> => {
    if (run.closeFlight !== undefined) return run.closeFlight;
    run.origin = undefined;
    const flight = trackCleanup(closeServer(run.server));
    run.closeFlight = flight;
    if (active === run) active = undefined;
    return flight;
  };

  const close = async (): Promise<void> => {
    const run = active;
    if (run?.closePage !== undefined) {
      await run.closePage();
    } else if (run !== undefined) {
      await closeRun(run);
    }
    if (cleanupFlights.size > 0) {
      await Promise.allSettled([...cleanupFlights]);
    }
  };

  return Object.freeze({
    ensureCompositionHost: async (signal: AbortSignal): Promise<boolean> => {
      if (signal.aborted) return false;
      let attemptedRun: ListenerRun | undefined;
      try {
        if (dependencies.compositionHost.current() === undefined) {
          await dependencies.compositionHost.ensureHeadlessHost();
        }
        if (signal.aborted || dependencies.compositionHost.current() === undefined) return false;

        const current = active;
        if (
          current?.origin !== undefined &&
          current.closeFlight === undefined &&
          current.server.listening
        ) {
          return true;
        }

        const candidate = createHttpServer((_request, response) => {
          response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
          });
          response.end(SYNTHETIC_BODY);
        });
        const run: ListenerRun = {
          server: candidate,
          listen: listenLoopback(candidate),
        };
        attemptedRun = run;
        active = run;
        const abortRun = (): void => {
          void closeRun(run);
        };
        signal.addEventListener("abort", abortRun, { once: true });
        try {
          const origin = await run.listen;
          if (signal.aborted || active !== run || run.closeFlight !== undefined) {
            await closeRun(run);
            return false;
          }
          run.origin = origin;
          return true;
        } finally {
          signal.removeEventListener("abort", abortRun);
        }
      } catch {
        if (attemptedRun !== undefined) await closeRun(attemptedRun);
        return false;
      }
    },
    loopbackOrigin: (): string => {
      const run = active;
      if (
        run?.origin === undefined ||
        run.closeFlight !== undefined ||
        !run.server.listening
      ) {
        throw new Error("readiness loopback listener is unavailable");
      }
      return run.origin;
    },
    openSyntheticLoopbackPage: async (
      { url, signal }: Readonly<{ url: string; signal: AbortSignal }>,
    ): Promise<BrowserReadinessSyntheticPage> => {
      const run = active;
      const origin = run?.origin;
      if (
        signal.aborted ||
        run === undefined ||
        origin === undefined ||
        run.closeFlight !== undefined ||
        !run.server.listening ||
        !url.startsWith(origin)
      ) {
        throw new Error("readiness page requested without its exact loopback origin");
      }
      const partition = `junto-readiness-${createNonce()}`;
      let view: BrowserViewHandle | undefined;
      let pageClosed = false;
      let closePageFlight: Promise<void> | undefined;
      let abortPage: (() => void) | undefined;
      const closePage = (): Promise<void> => {
        if (closePageFlight !== undefined) return closePageFlight;
        pageClosed = true;
        if (abortPage !== undefined) signal.removeEventListener("abort", abortPage);
        if (run.closePage === closePage) run.closePage = undefined;
        closePageFlight = trackCleanup((async () => {
          const currentView = view;
          try {
            currentView?.stopLoading?.();
          } catch {
            // Destruction remains mandatory even if Chromium rejects stop.
          }
          try {
            currentView?.detach();
          } catch {
            // Continue into owned destruction and listener closure.
          }
          try {
            currentView?.destroy();
          } catch {
            // The close receipt still waits for the listener below.
          }
          const destroyed = currentView?.whenDestroyed?.() ?? Promise.resolve();
          await Promise.allSettled([destroyed, closeRun(run)]);
        })());
        return closePageFlight;
      };
      try {
        view = await dependencies.viewAdapter(partition, readinessEvents(), { exactTopLevelOrigin: origin });
        view.attach({ x: 0, y: 0, width: 1, height: 1 });
        run.closePage = closePage;
        abortPage = () => {
          void closePage();
        };
        signal.addEventListener("abort", abortPage, { once: true });
        if (signal.aborted) {
          await closePage();
          throw new Error("readiness page creation was cancelled");
        }
        return Object.freeze({
          navigate: async (operationSignal: AbortSignal): Promise<boolean> => {
            if (operationSignal.aborted || pageClosed) return false;
            await view!.loadUrl(url, "readiness");
            return !operationSignal.aborted;
          },
          evaluate: async (operationSignal: AbortSignal): Promise<boolean> => {
            if (operationSignal.aborted || pageClosed || view!.executeJavaScript === undefined) return false;
            return successfulEval(await view!.executeJavaScript("document.title === 'Junto readiness'"));
          },
          screenshot: async (operationSignal: AbortSignal): Promise<boolean> => {
            if (operationSignal.aborted || pageClosed || view!.capturePagePng === undefined) return false;
            return hasPngSignature(await view!.capturePagePng());
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
