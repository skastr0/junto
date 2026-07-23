/** Linux Remote deployment provider.  The deployment program is deliberately
 * closed: artifact bytes arrive on stdin and the only mutable locations are
 * a per-user Vellum staging directory and the package manager's Vellum deb. */

import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import {
  lstat,
  open,
  realpath,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { Effect } from "effect";
import {
  readinessFromDisposition,
  rollbackFromDisposition,
  type DeployRemoteResult,
  type RemoteDeploymentProvider,
  type RemoteDeploymentProviderInput,
} from "./remote-deployment";

const LINUX_RECEIPT = /^LINUX_REMOTE_READY version=([0-9A-Za-z][0-9A-Za-z._+-]{0,63})$/u;
const DEB_NAME = /^Vellum Command-([0-9A-Za-z][0-9A-Za-z._+-]{0,63})-x64-linux\.deb$/u;
const DIAGNOSTIC_NAME =
  /^Vellum Command-([0-9A-Za-z][0-9A-Za-z._+-]{0,63})-x64-linux\.unpacked\.tar\.gz$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SOURCE_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const MAX_DEB_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const REQUIRED_EVIDENCE = new Set([
  "inventory.json",
  "package-audit.json",
  "packaged-pty-smoke.json",
  "packaged-runtime-smoke.json",
  "test-receipt.json",
]);
const EXPECTED_UNSUPPORTED = Object.freeze([
  "linux-arm64",
  "musl",
  "appimage",
  "snap",
  "flatpak",
  "rpm",
] as const);

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

const safeRelativeFile = (value: unknown): value is string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 240 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.endsWith("/")
  ) {
    return false;
  }
  const segments = value.split("/");
  return (
    segments.length <= 3 &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        /^[0-9A-Za-z][0-9A-Za-z ._+-]*$/u.test(segment),
    )
  );
};

const sha256File = async (file: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
};

const requireRegularEvidenceFile = async (
  root: string,
  relative: string,
  receipt: Pick<ReleaseEvidence, "bytes" | "sha256">,
): Promise<string> => {
  if (!safeRelativeFile(relative)) {
    throw new Error(`Linux Remote manifest declares an unsafe evidence path: ${relative}`);
  }
  const candidate = resolve(root, relative);
  if (!inside(root, candidate)) {
    throw new Error(`Linux Remote evidence path escapes its root: ${relative}`);
  }
  const metadata = await lstat(candidate);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size !== receipt.bytes
  ) {
    throw new Error(`Linux Remote evidence receipt does not match: ${relative}`);
  }
  const canonical = await realpath(candidate);
  if (!inside(root, canonical) || (await sha256File(canonical)) !== receipt.sha256) {
    throw new Error(`Linux Remote evidence receipt does not match: ${relative}`);
  }
  return canonical;
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
    diagnostic?: { format?: unknown; file?: unknown };
    source?: { commit?: unknown; sourceDateEpoch?: unknown };
    evidence?: unknown;
    unsupported?: unknown;
  };
  if (manifest?.schema !== "vellum/linux-release-evidence/v1" ||
    manifest.target?.os !== "linux" || manifest.target.architecture !== "x64" ||
    manifest.target.machine !== "x86_64" || manifest.target.distribution !== "ubuntu" ||
    manifest.target.distributionVersion !== "24.04" || manifest.target.libc !== "glibc" ||
    manifest.publishable?.format !== "deb" || !safeRelativeFile(manifest.publishable.file) ||
    manifest.diagnostic?.format !== "tar.gz" || !safeRelativeFile(manifest.diagnostic.file) ||
    typeof manifest.source?.commit !== "string" ||
    !SOURCE_COMMIT.test(manifest.source.commit) ||
    !Number.isSafeInteger(manifest.source.sourceDateEpoch) ||
    Number(manifest.source.sourceDateEpoch) <= 0 ||
    JSON.stringify(manifest.unsupported) !== JSON.stringify(EXPECTED_UNSUPPORTED) ||
    !Array.isArray(manifest.evidence) || manifest.evidence.length > 128) {
    throw new Error("Linux Remote requires an exact Ubuntu 24.04 x64 glibc release manifest");
  }
  const name = manifest.publishable.file.match(DEB_NAME);
  if (!name) throw new Error("Linux Remote manifest declares an invalid deb identity");
  const diagnostic = manifest.diagnostic.file.match(DIAGNOSTIC_NAME);
  if (!diagnostic || diagnostic[1] !== name[1]) {
    throw new Error("Linux Remote manifest declares an invalid diagnostic identity");
  }
  const evidence = manifest.evidence as ReleaseEvidence[];
  const release = evidence.filter((entry) => entry.scope === "release" && entry.file === manifest.publishable!.file);
  if (
    evidence.filter((entry) => entry.scope === "release").length !== 1 ||
    release.length !== 1 ||
    !Number.isSafeInteger(release[0].bytes) ||
    release[0].bytes <= 0 ||
    release[0].bytes > MAX_DEB_BYTES ||
    !SHA256.test(release[0].sha256)
  ) {
    throw new Error("Linux Remote manifest has no single bounded cryptographic deb receipt");
  }
  const seen = new Set<string>();
  let sanitizedLogs = 0;
  for (const entry of evidence) {
    if (
      (entry?.scope !== "release" && entry?.scope !== "evidence") ||
      !safeRelativeFile(entry.file) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes <= 0 ||
      entry.bytes > (entry.scope === "release" ? MAX_DEB_BYTES : MAX_EVIDENCE_BYTES) ||
      typeof entry.sha256 !== "string" ||
      !SHA256.test(entry.sha256)
    ) {
      throw new Error("Linux Remote manifest contains malformed release evidence");
    }
    const key = `${entry.scope}:${entry.file}`;
    if (seen.has(key)) {
      throw new Error(`Linux Remote manifest duplicates release evidence: ${entry.file}`);
    }
    seen.add(key);
    if (entry.scope === "evidence" && /^logs\/[^/]+\.log$/u.test(entry.file)) {
      sanitizedLogs += 1;
    }
  }
  if (
    !seen.has(`evidence:${manifest.diagnostic.file}`) ||
    sanitizedLogs === 0
  ) {
    throw new Error("Linux Remote manifest omits its diagnostic or sanitized logs");
  }
  const requestedEvidenceRoot = resolve(input.evidenceDirectory);
  const requestedEvidenceMetadata = await lstat(requestedEvidenceRoot);
  if (
    !requestedEvidenceMetadata.isDirectory() ||
    requestedEvidenceMetadata.isSymbolicLink()
  ) {
    throw new Error("Linux Remote evidence root is not a regular directory");
  }
  const evidenceRoot = await realpath(requestedEvidenceRoot);
  const evidenceRootMetadata = await lstat(evidenceRoot);
  if (!evidenceRootMetadata.isDirectory() || evidenceRootMetadata.isSymbolicLink()) {
    throw new Error("Linux Remote evidence root is not a regular directory");
  }
  for (const required of REQUIRED_EVIDENCE) {
    const receipt = evidence.filter((entry) => entry.scope === "evidence" && entry.file === required);
    if (receipt.length !== 1 || !Number.isSafeInteger(receipt[0].bytes) || receipt[0].bytes <= 0 || !SHA256.test(receipt[0].sha256)) {
      throw new Error(`Linux Remote manifest omits required evidence: ${required}`);
    }
  }
  const requestedReleaseRoot = resolve(input.releaseDirectory);
  const requestedReleaseMetadata = await lstat(requestedReleaseRoot);
  if (
    !requestedReleaseMetadata.isDirectory() ||
    requestedReleaseMetadata.isSymbolicLink()
  ) {
    throw new Error("Linux Remote release root is not a regular directory");
  }
  const root = await realpath(requestedReleaseRoot);
  const releaseRootMetadata = await lstat(root);
  if (!releaseRootMetadata.isDirectory() || releaseRootMetadata.isSymbolicLink()) {
    throw new Error("Linux Remote release root is not a regular directory");
  }
  for (const entry of evidence) {
    await requireRegularEvidenceFile(
      entry.scope === "release" ? root : evidenceRoot,
      entry.file,
      entry,
    );
  }
  const candidate = await realpath(resolve(root, manifest.publishable.file));
  if (!inside(root, candidate) || basename(candidate) !== manifest.publishable.file) {
    throw new Error("Linux Remote artifact path escapes its release directory");
  }
  const metadata = await lstat(candidate);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size !== release[0].bytes
  ) {
    throw new Error("Linux Remote deb does not match its manifest receipt");
  }
  return Object.freeze({ debPath: candidate, bytes: release[0].bytes, sha256: release[0].sha256, version: name[1] });
};

export type LinuxRemoteArtifactAuthority = {
  readonly resolve: () => Promise<LinuxArtifactAdmission>;
};

export const linuxRemoteArtifactBundleRoot = (home = homedir()): string =>
  join(home, ".vellum", "releases", "linux-x64-glibc", "current");

/**
 * Production artifact discovery is one fixed owner-local bundle layout. It
 * deliberately has no environment override, remote locator, or "newest file"
 * selection; an operator/installer must atomically place one exact CI bundle.
 */
export const makeProductionLinuxArtifactAuthority = (
  home = homedir(),
): LinuxRemoteArtifactAuthority => {
  const bundleRoot = linuxRemoteArtifactBundleRoot(home);
  const releaseDirectory = join(bundleRoot, "release");
  const evidenceDirectory = join(
    bundleRoot,
    "ci-evidence",
    "ubuntu-24.04-x64",
  );
  const manifestPath = join(evidenceDirectory, "manifest.json");
  return Object.freeze({
    resolve: async () => {
      const bundleMetadata = await lstat(bundleRoot);
      const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
      if (
        !bundleMetadata.isDirectory() ||
        bundleMetadata.isSymbolicLink() ||
        (bundleMetadata.mode & 0o022) !== 0 ||
        (expectedUid !== undefined && bundleMetadata.uid !== expectedUid)
      ) {
        throw new Error("Linux Remote release bundle is not owner-controlled");
      }
      let manifest: unknown;
      const manifestHandle = await open(
        manifestPath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      try {
        const manifestMetadata = await manifestHandle.stat();
        if (
          !manifestMetadata.isFile() ||
          manifestMetadata.size <= 0 ||
          manifestMetadata.size > MAX_MANIFEST_BYTES ||
          (manifestMetadata.mode & 0o022) !== 0 ||
          (expectedUid !== undefined && manifestMetadata.uid !== expectedUid)
        ) {
          throw new Error("Linux Remote release manifest is not an owner-controlled regular file");
        }
        try {
          manifest = JSON.parse(
            await manifestHandle.readFile({ encoding: "utf8" }),
          ) as unknown;
        } catch {
          throw new Error("Linux Remote release manifest is not valid JSON");
        }
      } finally {
        await manifestHandle.close();
      }
      return admitLinuxRemoteArtifact({
        manifest,
        releaseDirectory,
        evidenceDirectory,
      });
    },
  });
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
