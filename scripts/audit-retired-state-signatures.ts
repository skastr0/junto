import { lstat, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { extractFile, listPackage, statFile } from "@electron/asar";

export const RETIRED_PRODUCT_STATE_SIGNATURES = [
  "canvas-authority-v1",
  "current.json",
  "settings.json",
  "hosts.json",
  "station-status.json",
  "store.json",
  "topology.key",
  "topology.seal",
  "hosts.key",
  "hosts.seal",
  "incoming.frame",
  "applied.ack",
  "usage-state.json",
  "origin-key.json",
  "VELLUM_SETTINGS_PATH",
  "VELLUM_HOSTS_PATH",
  "VELLUM_STATION_STATUS_PATH",
  "VELLUM_CANVAS_AUTHORITY_DIR",
  "VELLUM_STATE_DB",
  "applyIrreversibleStateCutovers",
  "runtime_store_values",
  "state_metadata",
  "station_events",
  "station_outbound_sequences",
  "work_home_sequences",
  "runtime/open-url",
  "NodeRefRelay",
  "VELLUM_AUTHORIAL_WRITE",
  "CanvasControlRemove",
  "removeCanvasThroughControl",
  "canvas:rm",
  "control.canvas.remove",
  "originStationId",
  "origin_station_id",
  "StationBrowserStationId",
  "browser_origin_keys",
  "browser_pinned_origin_trust",
  "StationBrowserPinnedTrustRecord",
  "StationBrowserTrustRepository",
  "STATION_BROWSER_PROTOCOL_VERSION",
  "STATION_BROWSER_ORIGIN_ROUTE_PATH",
  "remoteVellumBrowserStation",
  "prepareStationBrowserRuntimeRoutes",
  "vellum/station-browser-owner/v1",
  "vellum-station-session-v1.",
  "/station-route",
  "browserTrust",
  "provision-station-browser-trust",
  "--peer-station-browser-protocol",
  "vellum:browser-automation-enable",
  "vellum:browser-automation-list",
  "vellum:browser-automation-revoke",
  "managedRemoteUpdate",
  "managedRemoteRollback",
  "rollback_previous_app",
  "BACKUP_RESTORE_PENDING",
  "remove_created_cli_link",
  "restore_previous_launchd_job",
  "PLIST_BACKUP_ID",
  "PLIST_RESTORE_PENDING",
] as const;

export type RetiredProductStateSignature =
  (typeof RETIRED_PRODUCT_STATE_SIGNATURES)[number];

export const RETIRED_PRODUCT_STATE_COMPOUND_SIGNATURES = [
  {
    label: "VELLUM_BROWSER_DIR + config.json",
    signatures: ["VELLUM_BROWSER_DIR", "config.json"],
  },
] as const;

export type RetiredStateSignatureAuditLimits = {
  readonly maxAsarEntries: number;
  readonly maxFirstPartyTextEntries: number;
  readonly maxAsarEntryBytes: number;
  readonly maxAsarTextBytes: number;
  readonly maxExecutableBytes: number;
};

export const RETIRED_STATE_SIGNATURE_AUDIT_LIMITS: Readonly<
  RetiredStateSignatureAuditLimits
> = Object.freeze({
  maxAsarEntries: 32_768,
  maxFirstPartyTextEntries: 4_096,
  maxAsarEntryBytes: 8 * 1024 * 1024,
  maxAsarTextBytes: 32 * 1024 * 1024,
  maxExecutableBytes: 96 * 1024 * 1024,
});

/** Measured Bun Linux runtime executables fit below 98 MiB; use a finite 112 MiB release bound. */
export const LINUX_RELEASE_HELPER_RETIRED_STATE_AUDIT_MAX_BYTES =
  112 * 1024 * 1024;

export type RetiredStateSignatureAuditErrorCode =
  | "retired-signature"
  | "invalid-limit"
  | "entry-bound"
  | "byte-bound"
  | "root-bound"
  | "invalid-entry"
  | "not-regular-file";

export class RetiredStateSignatureAuditError extends Error {
  readonly name = "RetiredStateSignatureAuditError";

  constructor(
    readonly code: RetiredStateSignatureAuditErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type RetiredStateBufferAuditReceipt = {
  readonly label: string;
  readonly scannedBytes: number;
};

export type RetiredStateAsarAuditReceipt = {
  readonly archivePath: string;
  readonly archiveEntries: number;
  readonly scannedEntries: number;
  readonly scannedBytes: number;
  readonly scannedRoots: readonly ["out", "station"];
};

export type RetiredStateBufferAuditOptions = {
  readonly label?: string;
  readonly maxBytes?: number;
};

export type RetiredStateAsarAuditOptions = {
  readonly limits?: Partial<RetiredStateSignatureAuditLimits>;
};

export type RetiredStateRuntimeBundlePaths = {
  readonly asarPath: string;
  readonly workCliPath: string;
};

export type RetiredStateRuntimeBundleAuditReceipt = {
  readonly asar: RetiredStateAsarAuditReceipt;
  readonly work: RetiredStateBufferAuditReceipt;
};

export type LinuxRetiredStateRuntimeBundlePaths =
  RetiredStateRuntimeBundlePaths & {
    readonly installerPath: string;
    readonly bridgePath: string;
  };

export type LinuxRetiredStateRuntimeBundleAuditReceipt =
  RetiredStateRuntimeBundleAuditReceipt & {
    readonly installer: RetiredStateBufferAuditReceipt;
    readonly bridge: RetiredStateBufferAuditReceipt;
  };

const FIRST_PARTY_ROOTS = ["out", "station"] as const;
type FirstPartyRoot = (typeof FIRST_PARTY_ROOTS)[number];

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".mjs",
  ".md",
  ".map",
  ".txt",
]);

const signatureBytes = RETIRED_PRODUCT_STATE_SIGNATURES.map(
  (signature) => ({
    signature,
    bytes: Buffer.from(signature, "utf8"),
  }),
);

const compoundSignatureBytes =
  RETIRED_PRODUCT_STATE_COMPOUND_SIGNATURES.map(
    ({ label, signatures }) => ({
      label,
      bytes: signatures.map((signature) =>
        Buffer.from(signature, "utf8")
      ),
    }),
  );

const requirePositiveSafeInteger = (
  name: string,
  value: number,
): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RetiredStateSignatureAuditError(
      "invalid-limit",
      `${name} must be a positive safe integer`,
    );
  }
  return value;
};

const resolvedLimits = (
  overrides: Partial<RetiredStateSignatureAuditLimits> = {},
): RetiredStateSignatureAuditLimits => ({
  maxAsarEntries: requirePositiveSafeInteger(
    "maxAsarEntries",
    overrides.maxAsarEntries ??
      RETIRED_STATE_SIGNATURE_AUDIT_LIMITS.maxAsarEntries,
  ),
  maxFirstPartyTextEntries: requirePositiveSafeInteger(
    "maxFirstPartyTextEntries",
    overrides.maxFirstPartyTextEntries ??
      RETIRED_STATE_SIGNATURE_AUDIT_LIMITS.maxFirstPartyTextEntries,
  ),
  maxAsarEntryBytes: requirePositiveSafeInteger(
    "maxAsarEntryBytes",
    overrides.maxAsarEntryBytes ??
      RETIRED_STATE_SIGNATURE_AUDIT_LIMITS.maxAsarEntryBytes,
  ),
  maxAsarTextBytes: requirePositiveSafeInteger(
    "maxAsarTextBytes",
    overrides.maxAsarTextBytes ??
      RETIRED_STATE_SIGNATURE_AUDIT_LIMITS.maxAsarTextBytes,
  ),
  maxExecutableBytes: requirePositiveSafeInteger(
    "maxExecutableBytes",
    overrides.maxExecutableBytes ??
      RETIRED_STATE_SIGNATURE_AUDIT_LIMITS.maxExecutableBytes,
  ),
});

const firstRetiredSignature = (
  bytes: Uint8Array,
): string | undefined => {
  const buffer = Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  const exact = signatureBytes.find(({ bytes: signature }) =>
    buffer.indexOf(signature) !== -1
  )?.signature;
  if (exact !== undefined) return exact;
  return compoundSignatureBytes.find(({ bytes: signatures }) =>
    signatures.every((signature) => buffer.indexOf(signature) !== -1)
  )?.label;
};

/**
 * Scan one first-party packaged payload without decoding it. This works for
 * JavaScript/text buffers and Bun-compiled vellum CLI executables alike.
 */
export const auditRetiredStateBuffer = (
  bytes: Uint8Array,
  options: RetiredStateBufferAuditOptions = {},
): RetiredStateBufferAuditReceipt => {
  const label = options.label ?? "packaged runtime buffer";
  const maxBytes = requirePositiveSafeInteger(
    "maxBytes",
    options.maxBytes ??
      RETIRED_STATE_SIGNATURE_AUDIT_LIMITS.maxExecutableBytes,
  );
  if (bytes.byteLength > maxBytes) {
    throw new RetiredStateSignatureAuditError(
      "byte-bound",
      `${label} exceeds retired-state scan bound (${bytes.byteLength} > ${maxBytes})`,
    );
  }
  const signature = firstRetiredSignature(bytes);
  if (signature !== undefined) {
    throw new RetiredStateSignatureAuditError(
      "retired-signature",
      `${label} contains retired product-state signature: ${signature}`,
    );
  }
  return { label, scannedBytes: bytes.byteLength };
};

/**
 * Bounded regular-file adapter for the packaged vellum CLI executable.
 */
export const auditRetiredStateFile = async (
  filePath: string,
  options: RetiredStateBufferAuditOptions = {},
): Promise<RetiredStateBufferAuditReceipt> => {
  const path = resolve(filePath);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new RetiredStateSignatureAuditError(
      "not-regular-file",
      `retired-state scan target is not a regular file: ${path}`,
    );
  }
  const maxBytes = requirePositiveSafeInteger(
    "maxBytes",
    options.maxBytes ??
      RETIRED_STATE_SIGNATURE_AUDIT_LIMITS.maxExecutableBytes,
  );
  if (info.size > maxBytes) {
    throw new RetiredStateSignatureAuditError(
      "byte-bound",
      `${options.label ?? path} exceeds retired-state scan bound (${info.size} > ${maxBytes})`,
    );
  }
  const bytes = await readFile(path);
  return auditRetiredStateBuffer(bytes, {
    label: options.label ?? path,
    maxBytes,
  });
};

const normalizeAsarEntry = (
  entry: string,
): { readonly root: FirstPartyRoot; readonly path: string } | undefined => {
  const path = entry.replace(/^\/+/u, "");
  const root = path.split("/", 1)[0];
  if (root !== "out" && root !== "station") return undefined;
  if (
    entry.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((segment) =>
      segment.length === 0 || segment === "." || segment === ".."
    )
  ) {
    throw new RetiredStateSignatureAuditError(
      "invalid-entry",
      `ASAR contains an invalid first-party entry: ${entry}`,
    );
  }
  if (!TEXT_EXTENSIONS.has(extname(path).toLowerCase())) return undefined;
  return { root, path };
};

/**
 * Scan the bounded first-party text/runtime surface inside app.asar. Third
 * party dependency strings are deliberately outside this product-state gate.
 */
export const auditRetiredStateAsar = (
  archivePath: string,
  options: RetiredStateAsarAuditOptions = {},
): RetiredStateAsarAuditReceipt => {
  const path = resolve(archivePath);
  const limits = resolvedLimits(options.limits);
  const entries = listPackage(path, { isPack: false });
  if (entries.length > limits.maxAsarEntries) {
    throw new RetiredStateSignatureAuditError(
      "entry-bound",
      `ASAR entry inventory exceeds retired-state scan bound (${entries.length} > ${limits.maxAsarEntries})`,
    );
  }

  const candidates: Array<{
    readonly root: FirstPartyRoot;
    readonly path: string;
    readonly bytes: number;
  }> = [];
  const seenPaths = new Set<string>();
  const seenRoots = new Set<FirstPartyRoot>();
  let scannedBytes = 0;

  for (const entry of entries) {
    const normalized = normalizeAsarEntry(entry);
    if (normalized === undefined) continue;
    if (seenPaths.has(normalized.path)) {
      throw new RetiredStateSignatureAuditError(
        "invalid-entry",
        `ASAR repeats a first-party entry: ${normalized.path}`,
      );
    }
    seenPaths.add(normalized.path);
    seenRoots.add(normalized.root);
    if (candidates.length >= limits.maxFirstPartyTextEntries) {
      throw new RetiredStateSignatureAuditError(
        "entry-bound",
        `ASAR first-party text inventory exceeds retired-state scan bound (${candidates.length + 1} > ${limits.maxFirstPartyTextEntries})`,
      );
    }

    const entryInfo = statFile(path, normalized.path, false);
    if (!("size" in entryInfo)) {
      throw new RetiredStateSignatureAuditError(
        "invalid-entry",
        `ASAR first-party text entry is not a regular file: ${normalized.path}`,
      );
    }
    if (entryInfo.size > limits.maxAsarEntryBytes) {
      throw new RetiredStateSignatureAuditError(
        "byte-bound",
        `ASAR entry exceeds retired-state scan bound: ${normalized.path} (${entryInfo.size} > ${limits.maxAsarEntryBytes})`,
      );
    }
    scannedBytes += entryInfo.size;
    if (scannedBytes > limits.maxAsarTextBytes) {
      throw new RetiredStateSignatureAuditError(
        "byte-bound",
        `ASAR first-party text exceeds retired-state scan bound (${scannedBytes} > ${limits.maxAsarTextBytes})`,
      );
    }
    candidates.push({
      ...normalized,
      bytes: entryInfo.size,
    });
  }

  for (const requiredRoot of FIRST_PARTY_ROOTS) {
    if (!seenRoots.has(requiredRoot)) {
      throw new RetiredStateSignatureAuditError(
        "root-bound",
        `ASAR has no scannable first-party ${requiredRoot}/ runtime`,
      );
    }
  }

  for (const candidate of candidates) {
    const bytes = extractFile(path, candidate.path, false);
    if (bytes.byteLength !== candidate.bytes) {
      throw new RetiredStateSignatureAuditError(
        "byte-bound",
        `ASAR entry size changed during retired-state scan: ${candidate.path}`,
      );
    }
    auditRetiredStateBuffer(bytes, {
      label: `app.asar:${candidate.path}`,
      maxBytes: limits.maxAsarEntryBytes,
    });
  }

  return {
    archivePath: path,
    archiveEntries: entries.length,
    scannedEntries: candidates.length,
    scannedBytes,
    scannedRoots: ["out", "station"],
  };
};

/**
 * One indivisible package gate for every first-party runtime payload. Platform
 * auditors call this instead of maintaining parallel target lists.
 */
export const auditRetiredStateRuntimeBundle = async (
  paths: RetiredStateRuntimeBundlePaths,
): Promise<RetiredStateRuntimeBundleAuditReceipt> => {
  const asar = auditRetiredStateAsar(paths.asarPath);
  const work = await auditRetiredStateFile(paths.workCliPath, {
    label: "packaged vellum",
  });
  return { asar, work };
};

/** Complete Linux runtime gate: ASAR plus packaged CLI and release tools. */
export const auditLinuxRetiredStateRuntimeBundle = async (
  paths: LinuxRetiredStateRuntimeBundlePaths,
): Promise<LinuxRetiredStateRuntimeBundleAuditReceipt> => {
  const asar = auditRetiredStateAsar(paths.asarPath);
  const [work, installer, bridge] = await Promise.all([
    auditRetiredStateFile(paths.workCliPath, {
      label: "packaged vellum",
      maxBytes: LINUX_RELEASE_HELPER_RETIRED_STATE_AUDIT_MAX_BYTES,
    }),
    auditRetiredStateFile(paths.installerPath, {
      label: "packaged vellum-release-installer",
      maxBytes: LINUX_RELEASE_HELPER_RETIRED_STATE_AUDIT_MAX_BYTES,
    }),
    auditRetiredStateFile(paths.bridgePath, {
      label: "packaged vellum-release-bridge",
      maxBytes: LINUX_RELEASE_HELPER_RETIRED_STATE_AUDIT_MAX_BYTES,
    }),
  ]);
  return { asar, work, installer, bridge };
};
