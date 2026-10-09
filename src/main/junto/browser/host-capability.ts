import {
  hostHasCapability,
  type RemoteHost,
} from "@shared/remote-hosts";
import { isThisMachine, isValidMachineName } from "@shared/machine-identity";

export interface BrowserHostCapabilityAuthority {
  readonly findHost: (hostId: string) => RemoteHost | undefined;
  /**
   * This machine's name. `undefined` means the machine list has not hydrated
   * yet, and admission must fail closed.
   */
  readonly machineName: () => string | undefined;
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
        | "machine-name-unavailable"
        | "physical-host-mismatch";
      readonly message: string;
    };

/**
 * A WebContentsView is a physical resource of this machine. The page's host is
 * document-derived; a caller cannot redirect creation by supplying a host.
 */
export const admitBrowserHostCapability = (
  hostId: string,
  authority: BrowserHostCapabilityAuthority,
): BrowserHostCapabilityAdmission => {
  if (!isValidMachineName(hostId)) {
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
  const machineName = authority.machineName();
  if (machineName === undefined) {
    return {
      ok: false,
      code: "unsupported_capability",
      reason: "machine-name-unavailable",
      message: "this machine's identity is not ready for browser work",
    };
  }
  if (!isThisMachine(hostId, machineName) || !host.isThisMachine) {
    return {
      ok: false,
      code: "unsupported_capability",
      reason: "physical-host-mismatch",
      message: "page host does not match this machine",
    };
  }
  return { ok: true, host };
};
