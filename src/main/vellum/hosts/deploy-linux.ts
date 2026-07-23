/** Linux Remote deployment provider.  The deployment program is deliberately
 * closed: artifact bytes arrive on stdin and the only mutable locations are
 * a per-user Vellum staging directory and the package manager's Vellum deb. */

import { Effect } from "effect";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import {
  readinessFromDisposition,
  rollbackFromDisposition,
  type DeployRemoteResult,
  type RemoteDeploymentProvider,
  type RemoteDeploymentProviderInput,
} from "./remote-deployment";

const LINUX_RECEIPT = /^LINUX_REMOTE_READY version=([0-9A-Za-z][0-9A-Za-z._+-]{0,63})$/u;
const DEB_NAME = /^Vellum Command-([0-9A-Za-z][0-9A-Za-z._+-]{0,63})-x64-linux\.deb$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_DEB_BYTES = 2 * 1024 * 1024 * 1024;
const REQUIRED_EVIDENCE = new Set([
  "package-audit.json",
  "packaged-pty-smoke.json",
  "packaged-runtime-smoke.json",
  "test-receipt.json",
]);

export type LinuxArtifactAdmission = {
  readonly debPath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly version: string;
};

type ReleaseEvidence = {
  readonly scope: "release" | "evidence";
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
};

const inside = (root: string, candidate: string): boolean =>
  candidate.startsWith(`${root}${sep}`);

const safeRelativeFile = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 160 &&
  !value.includes("\\0") && !value.includes("/") && !value.includes("\\");

const sha256File = async (file: string): Promise<string> => {
  return createHash("sha256").update(await readFile(file)).digest("hex");
};

/**
 * Admit precisely one CI-produced Ubuntu 24.04 x64 glibc deb.  This is local
 * evidence validation only; no SSH command is constructed until it succeeds.
 */
export const admitLinuxRemoteArtifact = async (input: {
  readonly manifest: unknown;
  readonly releaseDirectory: string;
  readonly evidenceDirectory: string;
}): Promise<LinuxArtifactAdmission> => {
  const manifest = input.manifest as {
    schema?: unknown;
    target?: { os?: unknown; architecture?: unknown; machine?: unknown; distribution?: unknown; distributionVersion?: unknown; libc?: unknown };
    publishable?: { format?: unknown; file?: unknown };
    evidence?: unknown;
  };
  if (manifest?.schema !== "vellum/linux-release-evidence/v1" ||
    manifest.target?.os !== "linux" || manifest.target.architecture !== "x64" ||
    manifest.target.machine !== "x86_64" || manifest.target.distribution !== "ubuntu" ||
    manifest.target.distributionVersion !== "24.04" || manifest.target.libc !== "glibc" ||
    manifest.publishable?.format !== "deb" || !safeRelativeFile(manifest.publishable.file) ||
    !Array.isArray(manifest.evidence)) {
    throw new Error("Linux Remote requires an exact Ubuntu 24.04 x64 glibc release manifest");
  }
  const name = manifest.publishable.file.match(DEB_NAME);
  if (!name) throw new Error("Linux Remote manifest declares an invalid deb identity");
  const evidence = manifest.evidence as ReleaseEvidence[];
  const release = evidence.filter((entry) => entry.scope === "release" && entry.file === manifest.publishable!.file);
  if (evidence.filter((entry) => entry.scope === "release").length !== 1 || release.length !== 1 || !Number.isSafeInteger(release[0].bytes) || release[0].bytes <= 0 || release[0].bytes > MAX_DEB_BYTES || !SHA256.test(release[0].sha256)) {
    throw new Error("Linux Remote manifest has no single bounded cryptographic deb receipt");
  }
  const evidenceRoot = await realpath(resolve(input.evidenceDirectory));
  for (const required of REQUIRED_EVIDENCE) {
    const receipt = evidence.filter((entry) => entry.scope === "evidence" && entry.file === required);
    if (receipt.length !== 1 || !Number.isSafeInteger(receipt[0].bytes) || receipt[0].bytes <= 0 || !SHA256.test(receipt[0].sha256)) {
      throw new Error(`Linux Remote manifest omits required evidence: ${required}`);
    }
    const evidencePath = resolve(evidenceRoot, required);
    if (!inside(evidenceRoot, evidencePath) || (await stat(evidencePath)).size !== receipt[0].bytes || (await sha256File(evidencePath)) !== receipt[0].sha256) {
      throw new Error(`Linux Remote evidence receipt does not match: ${required}`);
    }
  }
  const root = await realpath(resolve(input.releaseDirectory));
  const candidate = resolve(root, manifest.publishable.file);
  if (!inside(root, candidate) || basename(candidate) !== manifest.publishable.file) {
    throw new Error("Linux Remote artifact path escapes its release directory");
  }
  const metadata = await stat(candidate);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== release[0].bytes || (await sha256File(candidate)) !== release[0].sha256) {
    throw new Error("Linux Remote deb does not match its manifest receipt");
  }
  return Object.freeze({ debPath: candidate, bytes: release[0].bytes, sha256: release[0].sha256, version: name[1] });
};

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
