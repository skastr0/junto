/**
 * Internal browser product-path readiness proof.
 *
 * This is deliberately not a control route. The composition owner supplies
 * its already-authorized browser services through this narrow port, while the
 * receipt exposes only fixed readiness states to Doctor.
 */

import type {
  BrowserProductPathProbe,
  BrowserProductPathReceipt,
  StationReadinessComponentState,
} from "../station-readiness";

const PRODUCT_PATH_TIMEOUT_MS = 4_000;

export interface BrowserReadinessStationFacts {
  readonly role: string;
  readonly hostId: string;
  /** The current local host registry still declares browser capability. */
  readonly browserCapabilityDeclared: boolean;
  /** Browser control is live for the same local station, never merely a path. */
  readonly controlReady: boolean;
  /** Control was admitted by this exact physical station, not an adjacent host. */
  readonly controlHostId: string;
  /** The current Remote-local registry record that declares the capability. */
  readonly registeredRemoteHostId: string;
  /** Chromium's active sandbox policy has been checked by the composition owner. */
  readonly sandboxReady: boolean;
  /** The headless/visible composition owner has a usable display. */
  readonly displayReady: boolean;
}

export interface BrowserReadinessSyntheticPage {
  readonly navigate: (signal: AbortSignal) => Promise<boolean>;
  readonly evaluate: (signal: AbortSignal) => Promise<boolean>;
  readonly screenshot: (signal: AbortSignal) => Promise<boolean>;
  /** Idempotent and authority-owned; it must not wipe a profile. */
  readonly close: () => Promise<void>;
}

/**
 * The composition owner implements this using its existing session/view
 * services. It owns the loopback listener/page and must leave no profile or
 * canvas mutation behind after close.
 */
export interface BrowserReadinessProductPath {
  readonly ensureCompositionHost: (signal: AbortSignal) => Promise<boolean>;
  /** Ephemeral loopback listener owned by the composition, never a user page. */
  readonly loopbackOrigin: () => string;
  readonly openSyntheticLoopbackPage: (
    input: Readonly<{ url: string; signal: AbortSignal }>,
  ) => Promise<BrowserReadinessSyntheticPage>;
  /**
   * Closes the exact synthetic page/listener and joins cleanup already started
   * by cancellation, even if opening the page never returned a handle.
   */
  readonly close: () => Promise<void>;
}

export interface BrowserReadinessProbeOptions {
  readonly station: () => BrowserReadinessStationFacts;
  readonly productPath: BrowserReadinessProductPath;
  /** Tests may lower but never raise the production deadline. */
  readonly timeoutMs?: number;
  readonly createNonce?: () => string;
}

const boundedTimeout = (value: number | undefined): number => {
  if (value === undefined) return PRODUCT_PATH_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value <= 0 || value > PRODUCT_PATH_TIMEOUT_MS) {
    throw new RangeError("browser readiness timeout must be a bounded positive integer");
  }
  return value;
};

const hostIsValid = (value: string): boolean =>
  value.length > 0 && value.length <= 64 && /^(?!-)[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);

const unsupportedReceipt = (hostId: string): BrowserProductPathReceipt => ({
  version: 1,
  hostId,
  transport: "unsupported",
  composition: "unsupported",
  display: "unsupported",
  sandbox: "unsupported",
  capability: "unsupported",
});

const failedReceipt = (hostId: string): BrowserProductPathReceipt => ({
  version: 1,
  hostId,
  transport: "failed",
  composition: "failed",
  display: "failed",
  sandbox: "failed",
  capability: "failed",
});

const state = (ready: boolean): StationReadinessComponentState => ready ? "ready" : "failed";

const sameStationFacts = (
  left: BrowserReadinessStationFacts,
  right: BrowserReadinessStationFacts,
): boolean =>
  left.role === right.role &&
  left.hostId === right.hostId &&
  left.browserCapabilityDeclared === right.browserCapabilityDeclared &&
  left.controlReady === right.controlReady &&
  left.controlHostId === right.controlHostId &&
  left.registeredRemoteHostId === right.registeredRemoteHostId &&
  left.sandboxReady === right.sandboxReady &&
  left.displayReady === right.displayReady;

const settleBefore = async <T>(
  operation: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  cancel: () => void,
): Promise<T | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          cancel();
          resolve(undefined);
        }, timeoutMs);
      }),
      new Promise<undefined>((resolve) => {
        if (signal.aborted) resolve(undefined);
        else {
          abortListener = () => resolve(undefined);
          signal.addEventListener("abort", abortListener, { once: true });
        }
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortListener !== undefined) signal.removeEventListener("abort", abortListener);
  }
};

const loopbackUrl = (origin: string, nonce: string): string | undefined => {
  try {
    const parsed = new URL(origin);
    if (
      parsed.protocol !== "http:" ||
      parsed.hostname !== "127.0.0.1" ||
      parsed.port === "" ||
      Number(parsed.port) < 1024 ||
      Number(parsed.port) > 65_535 ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) return undefined;
    return `${parsed.href}junto-readiness?nonce=${encodeURIComponent(nonce)}`;
  } catch {
    return undefined;
  }
};

/**
 * Build the private producer consumed by the station readiness coordinator.
 * Concurrent callers share one synthetic page proof. A cancellation or failed
 * operation always runs the idempotent close path before the receipt escapes.
 */
export const makeBrowserProductPathProbe = (
  options: BrowserReadinessProbeOptions,
): BrowserProductPathProbe => {
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const createNonce = options.createNonce ?? (() => crypto.randomUUID());
  let flight: Promise<BrowserProductPathReceipt> | undefined;

  const probe = (callerSignal: AbortSignal): Promise<BrowserProductPathReceipt> => {
    if (flight !== undefined) return flight;
    const current: Promise<BrowserProductPathReceipt> = (async (): Promise<BrowserProductPathReceipt> => {
      const facts = options.station();
      if (facts.role !== "remote" || !hostIsValid(facts.hostId)) {
        return unsupportedReceipt(facts.hostId);
      }
      if (!facts.browserCapabilityDeclared || facts.registeredRemoteHostId !== facts.hostId) {
        return { ...unsupportedReceipt(facts.hostId), capability: "failed" };
      }
      if (!facts.controlReady || facts.controlHostId !== facts.hostId) {
        return { ...failedReceipt(facts.hostId), capability: "ready" };
      }
      if (!facts.displayReady || !facts.sandboxReady) {
        return {
          ...failedReceipt(facts.hostId),
          transport: "ready",
          display: state(facts.displayReady),
          sandbox: state(facts.sandboxReady),
          capability: "ready",
        };
      }

      const abort = new AbortController();
      const abortCaller = () => abort.abort(callerSignal.reason);
      if (callerSignal.aborted) abortCaller();
      else callerSignal.addEventListener("abort", abortCaller, { once: true });
      let page: BrowserReadinessSyntheticPage | undefined;
      try {
        const host = await settleBefore(
          options.productPath.ensureCompositionHost(abort.signal),
          abort.signal,
          timeoutMs,
          () => abort.abort("browser readiness deadline"),
        );
        if (host !== true) return { ...failedReceipt(facts.hostId), transport: "ready", display: "ready", sandbox: "ready", capability: "ready" };
        const url = loopbackUrl(options.productPath.loopbackOrigin(), createNonce());
        if (url === undefined) return { ...failedReceipt(facts.hostId), transport: "ready", composition: "ready", display: "ready", sandbox: "ready", capability: "ready" };
        page = await settleBefore(
          options.productPath.openSyntheticLoopbackPage({ url, signal: abort.signal }),
          abort.signal,
          timeoutMs,
          () => abort.abort("browser readiness deadline"),
        );
        if (page === undefined) return { ...failedReceipt(facts.hostId), transport: "ready", composition: "ready", display: "ready", sandbox: "ready", capability: "ready" };
        const navigation = await settleBefore(page.navigate(abort.signal), abort.signal, timeoutMs, () => abort.abort("browser readiness deadline"));
        const evaluation = navigation === true && await settleBefore(page.evaluate(abort.signal), abort.signal, timeoutMs, () => abort.abort("browser readiness deadline"));
        const screenshot = evaluation === true && await settleBefore(page.screenshot(abort.signal), abort.signal, timeoutMs, () => abort.abort("browser readiness deadline"));
        if (screenshot === true && !sameStationFacts(facts, options.station())) {
          return failedReceipt(facts.hostId);
        }
        return {
          version: 1,
          hostId: facts.hostId,
          transport: screenshot === true ? "ready" : "failed",
          composition: "ready",
          display: "ready",
          sandbox: "ready",
          capability: "ready",
        };
      } catch {
        return { ...failedReceipt(facts.hostId), transport: "ready", display: "ready", sandbox: "ready", capability: "ready" };
      } finally {
        callerSignal.removeEventListener("abort", abortCaller);
        if (page !== undefined) await page.close().catch(() => undefined);
        await options.productPath.close().catch(() => undefined);
      }
    })();
    flight = current;
    void current.finally(() => {
      if (flight === current) flight = undefined;
    });
    return current;
  };

  return Object.freeze({ probe });
};
