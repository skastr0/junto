/** Linux Remote deployment provider.  The deployment program is deliberately
 * closed: artifact bytes arrive on stdin and the only mutable locations are
 * a per-user Vellum staging directory and the package manager's Vellum deb. */

import { Effect } from "effect";
import {
  readinessFromDisposition,
  rollbackFromDisposition,
  type DeployRemoteResult,
  type RemoteDeploymentProvider,
  type RemoteDeploymentProviderInput,
} from "./remote-deployment";

const LINUX_RECEIPT = /^LINUX_REMOTE_READY version=([0-9A-Za-z][0-9A-Za-z._+-]{0,63})$/u;

/** Parse a deliberately tiny, single-line remote receipt; diagnostics are not evidence. */
export const decodeLinuxRemoteReceipt = (stdout: string): string | undefined => {
  if (!stdout.endsWith("\n") || stdout.indexOf("\n") !== stdout.length - 1) return undefined;
  return stdout.slice(0, -1).match(LINUX_RECEIPT)?.[1];
};

/**
 * The shell is a fixed product program.  No host, endpoint, role, artifact
 * metadata, or caller text is interpolated into it.  A future artifact
 * admission/streaming layer may invoke it only with its fixed stdin contract.
 */
export const buildLinuxRemoteDeployScript = (): string => `
set -eu
umask 077
BASE="$HOME/.vellum/deploy"
mkdir -p "$BASE"
STAGE="$(mktemp -d "$BASE/incoming.XXXXXX")"
cleanup() { rm -rf -- "$STAGE"; }
trap cleanup EXIT HUP INT TERM
DEB="$STAGE/vellum-remote.deb"
cat > "$DEB"
test -s "$DEB"
test "$(id -u)" -gt 0 || { echo AUTH_REQUIRED >&2; exit 41; }
command -v dpkg >/dev/null 2>&1 || { echo DPKG_UNAVAILABLE >&2; exit 42; }
dpkg-deb --info "$DEB" >/dev/null
dpkg --verify vellum-command >/dev/null 2>&1 || true
echo LINUX_REMOTE_STAGED
`.trim();

const unsupported = (input: RemoteDeploymentProviderInput): DeployRemoteResult => ({
  ok: false,
  detail: `${input.target.host.label}: Linux Remote package artifact is not admitted on this Command Center`,
  code: "not_found",
  message: "Linux Remote requires an exact clean-CI deb and manifest",
  stages: input.target.progress,
  disposition: "not-started",
});

/**
 * Artifact transport is intentionally unavailable until the clean-CI manifest
 * admission is wired.  Selecting Linux must never fall through to Darwin or
 * pretend that a terminal socket is browser-ready.
 */
export const linuxRemoteDeploymentProvider: RemoteDeploymentProvider = {
  platform: "linux",
  supportsBrowser: true,
  deploy: (input) => Effect.sync(() => {
    const result = input.target.platform.platform === "linux"
      ? unsupported(input)
      : {
        ok: false,
        detail: `${input.target.host.label}: Linux deployment provider refused ${input.target.platform.kernelName}`,
        code: "validation" as const,
        stages: input.target.progress,
        disposition: "not-started" as const,
      };
    return {
      result,
      targetPlatform: "linux" as const,
      stationConfiguration: input.stationConfiguration,
      authorizationRequirement: "operator" as const,
      readiness: readinessFromDisposition(result.disposition),
      rollback: rollbackFromDisposition(result.disposition),
    };
  }),
};
