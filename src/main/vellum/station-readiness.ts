/**
 * Bounded, public station-readiness read model.
 *
 * Producers retain their own authority: this module only asks the native PTY
 * probe and an injected browser product-path port for short-lived receipts.
 * It never receives a control token, page data, a capability, or a filesystem
 * path. That keeps Doctor useful without making it another control plane.
 */

import {
  probeNativeTerminalReadiness,
  type NativeTerminalReadiness,
} from "./term/native-readiness";

export const STATION_READINESS_VERSION = 1 as const;
const READINESS_TIMEOUT_MS = 5_000;

export type StationReadinessState =
  | "ready"
  | "degraded"
  | "unsupported"
  | "failed";

export type StationReadinessComponentState =
  | "ready"
  | "degraded"
  | "unsupported"
  | "failed";

export type BrowserProductPathReceipt = Readonly<{
  version: 1;
  /** The physical host that performed this exact product-path probe. */
  hostId: string;
  transport: StationReadinessComponentState;
  composition: StationReadinessComponentState;
  display: StationReadinessComponentState;
  sandbox: StationReadinessComponentState;
  capability: StationReadinessComponentState;
}>;

/**
 * Browser readiness is a port, rather than a convenience call into browser
 * control. The eventual producer must prove the product path itself and is
 * responsible for creating and cleaning any synthetic page it needs.
 */
export interface BrowserProductPathProbe {
  readonly probe: (signal: AbortSignal) => Promise<BrowserProductPathReceipt>;
}

export type StationReadinessComponents = Readonly<{
  version: StationReadinessComponentState;
  role: StationReadinessComponentState;
  host: StationReadinessComponentState;
  package: StationReadinessComponentState;
  supervisor: StationReadinessComponentState;
  canvasPull: StationReadinessComponentState;
  work: StationReadinessComponentState;
  terminal: StationReadinessComponentState;
  browserTransport: StationReadinessComponentState;
  browserComposition: StationReadinessComponentState;
  display: StationReadinessComponentState;
  sandbox: StationReadinessComponentState;
  browserCapability: StationReadinessComponentState;
}>;

export type StationReadinessReport = Readonly<{
  version: typeof STATION_READINESS_VERSION;
  state: StationReadinessState;
  components: StationReadinessComponents;
}>;

export interface StationReadinessInput {
  readonly version: string;
  readonly role: string;
  readonly hostId: string;
  /** Package identity is intentionally a label, never an install path. */
  readonly packageIdentity: string;
  readonly supervisorAligned: boolean;
  readonly canvasPull: "fresh" | "stale" | "missing" | "not-required";
  readonly workControlReady: boolean;
}

export interface StationReadinessCoordinatorOptions {
  readonly browser?: BrowserProductPathProbe;
  readonly terminalProbe?: () => Promise<NativeTerminalReadiness>;
  /** Tests may lower, never raise, the fixed readiness deadline. */
  readonly timeoutMs?: number;
}

const boundedTimeout = (candidate: number | undefined): number => {
  if (candidate === undefined) return READINESS_TIMEOUT_MS;
  if (!Number.isSafeInteger(candidate) || candidate <= 0 || candidate > READINESS_TIMEOUT_MS) {
    throw new RangeError("station readiness timeout must be a bounded positive integer");
  }
  return candidate;
};

const validIdentity = (value: string): boolean =>
  value.length > 0 && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._+@ -]*$/u.test(value);

const validHost = (value: string): boolean =>
  value.length > 0 && value.length <= 64 && /^(?!-)[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);

const stateFromTerminal = (value: NativeTerminalReadiness): StationReadinessComponentState =>
  value.ready ? "ready" : "failed";

const overallState = (components: StationReadinessComponents): StationReadinessState => {
  const states = Object.values(components);
  if (states.includes("failed")) return "failed";
  if (states.includes("degraded")) return "degraded";
  if (states.includes("unsupported")) return "unsupported";
  return "ready";
};

const browserUnavailable = (state: "unsupported" | "degraded" | "failed") => ({
  browserTransport: state,
  browserComposition: state,
  display: state,
  sandbox: state,
  browserCapability: state,
} as const);

const settleBefore = async <T>(
  operation: Promise<T>,
  timeoutMs: number,
  abort: AbortController,
): Promise<T | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          abort.abort("station readiness deadline");
          resolve(undefined);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/**
 * A coordinator is intentionally one-flight: concurrent Doctor callers see
 * the same bounded evidence rather than creating competing synthetic browser
 * sessions or terminal probes.
 */
export const createStationReadinessCoordinator = (
  options: StationReadinessCoordinatorOptions = {},
) => {
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const terminalProbe = options.terminalProbe ?? probeNativeTerminalReadiness;
  let flight: Promise<StationReadinessReport> | undefined;

  const assess = (input: StationReadinessInput): Promise<StationReadinessReport> => {
    if (flight !== undefined) return flight;
    flight = (async () => {
      const abort = new AbortController();
      const [terminal, browser] = await Promise.all([
        settleBefore(terminalProbe(), timeoutMs, abort).catch(() => undefined),
        options.browser === undefined
          ? Promise.resolve<BrowserProductPathReceipt | undefined>(undefined)
          : settleBefore(options.browser.probe(abort.signal), timeoutMs, abort).catch(() => undefined),
      ]);

      const browserComponents =
        options.browser === undefined
          ? browserUnavailable("unsupported")
          : browser === undefined
            ? browserUnavailable("failed")
            : browser.version !== STATION_READINESS_VERSION || browser.hostId !== input.hostId
              ? browserUnavailable("failed")
              : {
                  browserTransport: browser.transport,
                  browserComposition: browser.composition,
                  display: browser.display,
                  sandbox: browser.sandbox,
                  browserCapability: browser.capability,
                };
      const components: StationReadinessComponents = {
        version: validIdentity(input.version) ? "ready" : "degraded",
        role: input.role === "remote" || input.role === "command-center" ? "ready" : "degraded",
        host: validHost(input.hostId) ? "ready" : "degraded",
        package: validIdentity(input.packageIdentity) ? "ready" : "degraded",
        supervisor: input.supervisorAligned ? "ready" : "degraded",
        canvasPull: input.canvasPull === "fresh" || input.canvasPull === "not-required" ? "ready" : "degraded",
        work: input.workControlReady ? "ready" : "degraded",
        terminal: terminal === undefined ? "failed" : stateFromTerminal(terminal),
        ...browserComponents,
      };
      return Object.freeze({
        version: STATION_READINESS_VERSION,
        state: overallState(components),
        components: Object.freeze(components),
      });
    })();
    void flight.finally(() => {
      if (flight !== undefined) flight = undefined;
    });
    return flight;
  };

  return Object.freeze({ assess });
};

/** Stable, bounded ServiceCheck metadata projection; it never carries detail. */
export const stationReadinessMetadata = (
  report: StationReadinessReport,
): Readonly<Record<string, string>> => ({
  readinessVersion: String(report.version),
  readinessState: report.state,
  ...Object.fromEntries(
    Object.entries(report.components).map(([name, state]) => [
      `readiness.${name}`,
      state,
    ]),
  ),
});
