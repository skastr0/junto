/**
 * Operator-facing copy for Remote deploy, doctor, and folder/terminal reach.
 * No protocol nouns. No proof-banner leftovers.
 */
import { classifyHostRuntimeBlocker } from "./host-runtime";

const replaceStationApi = (detail: string): string =>
  detail.replaceAll(/Station API/giu, "Vellum Command");

/** Deploy / doctor strings the operator can act on. */
export const operatorDeployDetail = (detail: string): string => {
  const blocker = classifyHostRuntimeBlocker(detail);
  if (blocker !== undefined) return blocker.detail;
  if (/DEPLOY_ALREADY_IN_PROGRESS/u.test(detail)) {
    return "Another Vellum Command install is already running on that Mac. Wait for it to finish, then Deploy again.";
  }
  if (
    /SSH process I\/O failed|SSH .+ closed before it finished/iu.test(detail)
  ) {
    return "The connection to that machine dropped while copying Vellum Command. If it is still on the network, Deploy again.";
  }
  if (
    /did not prove a fresh launchd|did not prove a fresh launchd generation/iu.test(
      detail,
    )
  ) {
    return "Vellum Command finished copying, but that Mac did not confirm it started. Deploy again. If it keeps failing, open Vellum Command there, quit it, then retry.";
  }
  if (
    /term control|terminal-plane|terminal plane|TERM_SOCK/iu.test(detail)
  ) {
    return "Vellum Command is not answering for folders or terminals on that machine. If it is on the network, Deploy again.";
  }
  if (
    /ENROLLMENT_READY|STATION_READY|ENROLLMENT_PARTIAL|ENROLLMENT_SOCKET_TIMEOUT|RUNTIME_SOCKET_TIMEOUT|NEW_LAUNCHD_/iu.test(
      detail,
    )
  ) {
    return "Vellum Command is on that machine, but startup did not finish. Deploy again.";
  }
  if (/package replacement admitted/iu.test(detail)) {
    return "Vellum Command is not answering on that machine — no live terminal to pause. Continuing the install.";
  }
  if (/not enrolled in the persistent fleet/iu.test(detail)) {
    return "This machine is not in the fleet yet.";
  }
  return replaceStationApi(detail);
};

/**
 * Folder picker / terminal reach. SSH up + app down is not "can't reach the Mac".
 */
export const operatorRemoteWorkDetail = (
  hostLabel: string,
  cause: unknown,
): string => {
  const raw = cause instanceof Error ? cause.message : String(cause);
  if (/is not a remote SSH endpoint|SSH route changed/iu.test(raw)) {
    return `${hostLabel} is not a remote machine Vellum Command can open.`;
  }
  if (
    /term control connect timeout|cannot reach term control|no term control|ECONNREFUSED|ENOENT/iu.test(
      raw,
    )
  ) {
    return `Vellum Command is not answering on ${hostLabel}. If that machine is on the network, Deploy again. Folder browsing starts after Vellum Command is running there.`;
  }
  if (/permission denied|publickey|Authentication failed/iu.test(raw)) {
    return `That machine refused SSH for ${hostLabel}. Check Tailscale SSH and that this user can log in.`;
  }
  if (/timed out|ETIMEDOUT|Could not resolve/iu.test(raw)) {
    return `Can't reach ${hostLabel} on the network. Check Tailscale, then try again.`;
  }
  return `Could not open folders on ${hostLabel}. ${operatorDeployDetail(raw)}`;
};

/** True when list/get should stay empty, not throw. */
export const isMissingRemoteHostError = (cause: unknown): boolean => {
  const raw = cause instanceof Error ? cause.message : String(cause);
  return /is not a remote SSH endpoint|SSH route changed/iu.test(raw);
};
