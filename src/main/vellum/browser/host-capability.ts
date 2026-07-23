import {
  hostHasCapability,
  type RemoteHost,
} from "@shared/remote-hosts";
import { isValidStationHostId, type StationRole } from "@shared/station";
import { findHostById } from "../hosts/snapshot";
import { getStationScope } from "../kernel/cycle";

export interface BrowserHostCapabilityAuthority {
  readonly findHost: (hostId: string) => RemoteHost | undefined;
  readonly station: () => {
    readonly hostId: string;
    readonly role: StationRole;
  };
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
        | "physical-host-mismatch";
      readonly message: string;
    };

export const defaultBrowserHostCapabilityAuthority: BrowserHostCapabilityAuthority =
  Object.freeze({
    findHost: findHostById,
    station: getStationScope,
  });

/**
 * A WebContentsView is a physical resource of this station. The page's host is
 * document-derived; a caller cannot redirect creation by supplying a host.
 */
export const admitBrowserHostCapability = (
  hostId: string,
  authority: BrowserHostCapabilityAuthority =
    defaultBrowserHostCapabilityAuthority,
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
  if (authority.station().hostId !== hostId) {
    return {
      ok: false,
      code: "unsupported_capability",
      reason: "physical-host-mismatch",
      message: "page host does not match this physical station",
    };
  }
  return { ok: true, host };
};
