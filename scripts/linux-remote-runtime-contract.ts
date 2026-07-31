/**
 * Node-safe Linux Remote runtime contract.
 *
 * This module is imported by both release admission (which is reachable from
 * the displayless Remote bundle) and build-time package audits. Keep it free of
 * Electron, ASAR, package mutation, and CLI side effects.
 */

export const DEFAULT_NODE_REMOTE_VERSION = "24.18.0";

/**
 * Reviewed official Node linux-x64 tarball digests keyed by exact version.
 * Source: https://nodejs.org/dist/v{version}/SHASUMS256.txt
 */
export const PINNED_NODE_LINUX_X64_ARCHIVE_SHA256: Readonly<
  Record<string, string>
> = Object.freeze({
  "24.18.0":
    "783130984963db7ba9cbd01089eaf2c2efb055c7c1693c943174b967b3050cb8",
});

const SEMVER =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export const requireNodeRemoteVersion = (value: unknown): string => {
  if (typeof value !== "string" || !SEMVER.test(value)) {
    throw new Error(
      `invalid NODE_REMOTE_VERSION (need semver x.y.z): ${String(value)}`,
    );
  }
  const [majorText, minorText] = value.split(".");
  const major = Number(majorText);
  const minor = Number(minorText);
  if (major !== 24 || minor < 10) {
    throw new Error(
      `NODE_REMOTE_VERSION must be Node 24 LTS >=24.10 (got ${value}); Remote requires DatabaseSync.setAuthorizer`,
    );
  }
  return value;
};

export const pinnedNodeLinuxX64ArchiveSha256 = (
  version: string,
): string => {
  const resolved = requireNodeRemoteVersion(version);
  const digest = PINNED_NODE_LINUX_X64_ARCHIVE_SHA256[resolved];
  if (digest === undefined || !/^[0-9a-f]{64}$/u.test(digest)) {
    throw new Error(
      `no reviewed Node linux-x64 archive digest is pinned for ${resolved}`,
    );
  }
  return digest;
};

export const LINUX_REMOTE_RUNTIME_AUDIT_SCHEMA =
  "vellum/linux-remote-runtime-audit/v1" as const;

export const LINUX_REMOTE_RUNTIME_AUDIT_EXPECTED = Object.freeze({
  schema: LINUX_REMOTE_RUNTIME_AUDIT_SCHEMA,
  nodeVersion: `v${DEFAULT_NODE_REMOTE_VERSION}`,
  nodeArchiveSha256:
    pinnedNodeLinuxX64ArchiveSha256(DEFAULT_NODE_REMOTE_VERSION),
  nodeSqlite: "exercised",
  sqliteAuthorizer: "exercised",
  xtermHeadless: "exercised",
  xtermSerialize: "exercised",
} as const);

export type LinuxRemoteRuntimeAuditReceipt =
  typeof LINUX_REMOTE_RUNTIME_AUDIT_EXPECTED;

const record = (
  value: unknown,
): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;

export const validateLinuxRemoteRuntimeAuditReceipt = (
  value: unknown,
): LinuxRemoteRuntimeAuditReceipt => {
  const receipt = record(value);
  if (
    receipt === undefined ||
    JSON.stringify(Object.keys(receipt).sort()) !==
      JSON.stringify(Object.keys(LINUX_REMOTE_RUNTIME_AUDIT_EXPECTED).sort())
  ) {
    throw new Error("packaged Remote runtime audit receipt is malformed");
  }
  for (const [key, expected] of Object.entries(
    LINUX_REMOTE_RUNTIME_AUDIT_EXPECTED,
  )) {
    if (receipt[key] !== expected) {
      throw new Error(
        `packaged Remote runtime audit mismatch: ${key}`,
      );
    }
  }
  return LINUX_REMOTE_RUNTIME_AUDIT_EXPECTED;
};
