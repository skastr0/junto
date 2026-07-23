import {
  hostHasCapability,
  type RemoteHost,
} from "@shared/remote-hosts";
import { isValidStationHostId, type StationRole } from "@shared/station";

export interface BrowserHostCapabilityAuthority {
  readonly findHost: (hostId: string) => RemoteHost | undefined;
  /**
   * Durable, hydrated physical-station identity. `undefined` means startup or
   * onboarding has not established an identity yet and must fail closed.
   */
  readonly station: () =>
    | {
        readonly hostId: string;
        readonly role: StationRole;
      }
    | undefined;
}

export type BrowserHostCapabilityAdmission =
  | { readonly ok: true; readonly host: RemoteHost }
  | {
      readonly ok: false;
      readonly code: "invalid" | "unsupported_capability";
      readonly reason:
        | "invalid-host"
        | "host-not-registered"
        | "browser-not-declared"
        | "station-identity-unavailable"
        | "physical-host-mismatch";
      readonly message: string;
    };

/**
 * A WebContentsView is a physical resource of this station. The page's host is
 * document-derived; a caller cannot redirect creation by supplying a host.
 */
export const admitBrowserHostCapability = (
  hostId: string,
  authority: BrowserHostCapabilityAuthority,
): BrowserHostCapabilityAdmission => {
  if (!isValidStationHostId(hostId)) {
    return {
      ok: false,
      code: "invalid",
      reason: "invalid-host",
      message: "resolved page target has an invalid host",
    };
  }
  const host = authority.findHost(hostId);
  if (host === undefined) {
    return {
      ok: false,
      code: "unsupported_capability",
      reason: "host-not-registered",
      message: "page host is not registered for browser work",
    };
  }
  if (!hostHasCapability(host, "browser")) {
    return {
      ok: false,
      code: "unsupported_capability",
      reason: "browser-not-declared",
      message: "page host does not declare browser capability",
    };
  }
  const station = authority.station();
  if (station === undefined) {
    return {
      ok: false,
      code: "unsupported_capability",
      reason: "station-identity-unavailable",
      message: "physical station identity is not ready for browser work",
    };
  }
  const roleMatchesPhysicalHost =
    station.role === "command-center"
      ? station.hostId === "local" &&
        host.id === "local" &&
        host.kind === "local"
      : station.hostId !== "local" &&
        host.id === station.hostId &&
        host.kind === "remote";
  if (station.hostId !== hostId || !roleMatchesPhysicalHost) {
    return {
      ok: false,
      code: "unsupported_capability",
      reason: "physical-host-mismatch",
      message: "page host does not match this physical station",
    };
  }
  return { ok: true, host };
};
