import {
  canonicalStationBrowserJson,
  decodeStationBrowserEnvelope,
  decodeStationBrowserResponse,
  type StationBrowserDenial,
  type StationBrowserResponse,
} from "@shared/station-browser";
import {
  StationBrowserReplayCache,
  verifyStationBrowserEnvelope,
  type StationBrowserTrust,
  type StationBrowserVerificationContext,
} from "./station-delegation";

export interface StationBrowserWrapper {
  readonly handle: (frame: string) => Promise<string>;
}

export interface StationBrowserWrapperDeps {
  readonly trust: StationBrowserTrust;
  readonly verification: () => StationBrowserVerificationContext;
  readonly replays: StationBrowserReplayCache;
  /** Target-local execution only; it receives a request only after verification. */
  readonly execute: (request: Parameters<StationBrowserVerificationContext["allowAction"]>[0]) => Promise<unknown>;
}

const rejected = (requestId: string, action: StationBrowserResponse["action"], hostId: string, error: StationBrowserDenial): StationBrowserResponse => ({ version: 1, requestId, action, ok: false, hostId, data: null, error });

/** Target-side fixed-wrapper core. The executable composition supplies only host-local services. */
export const makeStationBrowserWrapper = (deps: StationBrowserWrapperDeps): StationBrowserWrapper => ({
  handle: async (frame) => {
    const envelope = decodeStationBrowserEnvelope(frame);
    if (typeof envelope === "string") return "";
    const verified = verifyStationBrowserEnvelope(frame, deps.trust, deps.verification(), deps.replays);
    if (!verified.ok) return canonicalStationBrowserJson(rejected(envelope.request.requestId, envelope.request.action, deps.verification().stationId, verified.denial));
    try {
      const data = await deps.execute(verified.request);
      const response: StationBrowserResponse = { version: 1, requestId: verified.request.requestId, action: verified.request.action, ok: true, hostId: deps.verification().stationId, data, error: null };
      return typeof decodeStationBrowserResponse(canonicalStationBrowserJson(response)) === "string"
        ? canonicalStationBrowserJson(rejected(verified.request.requestId, verified.request.action, deps.verification().stationId, "limits"))
        : canonicalStationBrowserJson(response);
    } catch {
      return canonicalStationBrowserJson(rejected(verified.request.requestId, verified.request.action, deps.verification().stationId, "forbidden"));
    }
  },
});
