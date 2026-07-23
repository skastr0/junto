import {
  canonicalStationBrowserJson,
  decodeStationBrowserEnvelope,
  decodeStationBrowserResponse,
  type StationBrowserAction,
  type StationBrowserDenial,
} from "@shared/station-browser";
import {
  StationBrowserReplayCache,
  verifyStationBrowserEnvelope,
  type StationBrowserTrust,
  type StationBrowserVerificationContext,
} from "./station-delegation";

export interface StationBrowserWrapper {
  readonly handle: (frame: string, signal?: AbortSignal) => Promise<string>;
}

export interface StationBrowserWrapperDeps {
  /**
   * A provider is re-read for every request so a pinned-key rotation or
   * revocation takes effect without retaining stale in-memory authority.
   */
  readonly trust:
    | StationBrowserTrust
    | (() =>
        | StationBrowserTrust
        | undefined
        | Promise<StationBrowserTrust | undefined>);
  readonly verification: () => StationBrowserVerificationContext;
  readonly replays: StationBrowserReplayCache;
  /** Target-local execution only; it receives a request only after verification. */
  readonly execute: (
    request: Parameters<StationBrowserVerificationContext["allowAction"]>[0],
    signal?: AbortSignal,
  ) => Promise<unknown>;
}

const rejected = (requestId: string, action: StationBrowserAction, hostId: string, error: StationBrowserDenial) => ({ version: 1, requestId, action, ok: false, hostId, data: null, error });

/** Target-side fixed-wrapper core. The executable composition supplies only host-local services. */
export const makeStationBrowserWrapper = (deps: StationBrowserWrapperDeps): StationBrowserWrapper => ({
  handle: async (frame, signal) => {
    const envelope = decodeStationBrowserEnvelope(frame);
    if (typeof envelope === "string") return "";
    const context = deps.verification();
    let trust: StationBrowserTrust | undefined;
    try {
      trust =
        typeof deps.trust === "function"
          ? await deps.trust()
          : deps.trust;
    } catch {
      trust = undefined;
    }
    if (trust === undefined) {
      return canonicalStationBrowserJson(
        rejected(
          envelope.request.requestId,
          envelope.request.action,
          context.stationId,
          "key",
        ),
      );
    }
    const verified = verifyStationBrowserEnvelope(
      frame,
      trust,
      context,
      deps.replays,
    );
    if (!verified.ok) return canonicalStationBrowserJson(rejected(envelope.request.requestId, envelope.request.action, context.stationId, verified.denial));
    try {
      if (signal?.aborted) {
        return canonicalStationBrowserJson(
          rejected(
            verified.request.requestId,
            verified.request.action,
            context.stationId,
            "forbidden",
          ),
        );
      }
      const data = await deps.execute(verified.request, signal);
      const response = { version: 1 as const, requestId: verified.request.requestId, action: verified.request.action, ok: true as const, hostId: context.stationId, data, error: null };
      return typeof decodeStationBrowserResponse(canonicalStationBrowserJson(response)) === "string"
        ? canonicalStationBrowserJson(rejected(verified.request.requestId, verified.request.action, context.stationId, "limits"))
        : canonicalStationBrowserJson(response);
    } catch {
      return canonicalStationBrowserJson(rejected(verified.request.requestId, verified.request.action, context.stationId, "forbidden"));
    }
  },
});
