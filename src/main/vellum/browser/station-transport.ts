import { Effect } from "effect";
import {
  BROWSER_HOST_CAPABILITY,
  hostHasCapability,
  type RemoteHost,
} from "@shared/remote-hosts";
import {
  canonicalStationBrowserJson,
  decodeStationBrowserEnvelope,
  decodeStationBrowserResponse,
  type StationBrowserEnvelope,
  type StationBrowserResponse,
} from "@shared/station-browser";
import {
  makeRemoteStdin,
  parseSshEndpoint,
  type SshError,
} from "../ssh/domain";
import { oneShotWithStdin } from "../ssh/program";
import { remoteVellumBrowserStation } from "../ssh/read-commands";
import type { SshTransport } from "../ssh/service";

/** Package-owned remote entrypoint. It accepts exactly one signed JSON frame on stdin. */
export const STATION_BROWSER_WRAPPER = "vellum-browser";
export const STATION_BROWSER_WRAPPER_ARGS = ["station"] as const;

export class StationBrowserTransportError extends Error {
  constructor(
    readonly code: "host_unavailable" | "host_capability" | "target_mismatch" | "malformed_response",
    message: string,
  ) {
    super(message);
    this.name = "StationBrowserTransportError";
  }
}

type Ssh = typeof SshTransport.Service;

const resolveTarget = (
  hosts: ReadonlyArray<RemoteHost>,
  envelope: StationBrowserEnvelope,
): Effect.Effect<RemoteHost, StationBrowserTransportError> => {
  const target = hosts.find((host) => host.id === envelope.request.targetStationId);
  if (target === undefined || target.kind !== "remote" || target.endpoint === undefined) {
    return Effect.fail(new StationBrowserTransportError("host_unavailable", "browser target is not an available remote station"));
  }
  if (!hostHasCapability(target, BROWSER_HOST_CAPABILITY)) {
    return Effect.fail(new StationBrowserTransportError("host_capability", "browser target does not advertise browser capability"));
  }
  return Effect.succeed(target);
};

/**
 * Sends an already-minted delegation to the host named inside that delegation.
 * No endpoint, executable, option, or remote command text is caller supplied.
 */
export const dispatchStationBrowser = (
  ssh: Ssh,
  hosts: ReadonlyArray<RemoteHost>,
  envelope: StationBrowserEnvelope,
): Effect.Effect<StationBrowserResponse, StationBrowserTransportError | SshError> =>
  Effect.gen(function* () {
    const wire = canonicalStationBrowserJson(envelope);
    const decoded = decodeStationBrowserEnvelope(wire);
    if (typeof decoded === "string") {
      return yield* Effect.fail(new StationBrowserTransportError("target_mismatch", "station browser delegation is not a valid bounded envelope"));
    }
    if (decoded.request.targetStationId !== envelope.request.targetStationId) {
      return yield* Effect.fail(new StationBrowserTransportError("target_mismatch", "station browser delegation target changed during encoding"));
    }
    const host = yield* resolveTarget(hosts, decoded);
    const endpoint = yield* parseSshEndpoint(host.endpoint).pipe(
      Effect.mapError((error) => new StationBrowserTransportError("host_unavailable", error.message)),
    );
    const command = yield* remoteVellumBrowserStation().pipe(
      Effect.mapError((error) => new StationBrowserTransportError("host_unavailable", error.message)),
    );
    const input = yield* makeRemoteStdin(wire).pipe(
      Effect.mapError((error) => new StationBrowserTransportError("host_unavailable", error.message)),
    );
    const result = yield* ssh.run(oneShotWithStdin(endpoint, command, input, { budget: "standard" }));
    const response = decodeStationBrowserResponse(result.stdout);
    if (typeof response === "string" || response.requestId !== decoded.request.requestId || response.action !== decoded.request.action || response.hostId !== host.id) {
      return yield* Effect.fail(new StationBrowserTransportError("malformed_response", "remote browser station returned an invalid response"));
    }
    return response;
  });
