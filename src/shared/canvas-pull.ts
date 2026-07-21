/**
 * Remote → Command Center canvas pull (read-only foundation).
 *
 * Product nouns only: Command Center authors canvases; Remote pulls them.
 * Pure helpers — no I/O, no board IDs.
 */

/** Same alphabet as canvases.ts / node-ref (lowercase letters, digits, hyphens). */
export const CANVAS_PULL_NAME_PATTERN = /^[a-z0-9-]+$/;

export const isValidCanvasPullName = (name: string): boolean =>
  name.length > 0 && name.length <= 128 && CANVAS_PULL_NAME_PATTERN.test(name);

/** Basename of a canvas document file (`portfolio` → `portfolio.canvas`). */
export const canvasPullFileName = (name: string): string => `${name}.canvas`;

/**
 * Extract a canvas name from a remote listing entry (basename or full path).
 * Rejects path traversal and non-conforming names.
 */
export const canvasNameFromListingEntry = (entry: string): string | undefined => {
  const trimmed = entry.trim();
  if (trimmed.length === 0) return undefined;
  // Reject absolute paths, parent refs, and multi-segment paths with traversal.
  if (trimmed.includes("\0") || trimmed.includes("..")) return undefined;
  const base = trimmed.includes("/")
    ? trimmed.slice(trimmed.lastIndexOf("/") + 1)
    : trimmed.includes("\\")
      ? trimmed.slice(trimmed.lastIndexOf("\\") + 1)
      : trimmed;
  if (!base.endsWith(".canvas")) return undefined;
  const name = base.slice(0, -".canvas".length);
  return isValidCanvasPullName(name) ? name : undefined;
};

/**
 * Parse `ls -1` (or similar) stdout from the Command Center canvases directory
 * into a sorted unique list of valid canvas names.
 */
export const parseRemoteCanvasListing = (stdout: string): ReadonlyArray<string> => {
  const names = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const name = canvasNameFromListingEntry(line);
    if (name !== undefined) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
};

/** Minimal host row for endpoint resolution (registry-shaped). */
export type CanvasPullHostRow = {
  readonly id: string;
  readonly kind: "local" | "remote";
  readonly endpoint?: string;
};

export type ResolveCommandCenterEndpointResult =
  | {
      readonly ok: true;
      readonly endpoint: string;
      readonly source: "host" | "direct";
    }
  | {
      readonly ok: false;
      readonly detail: string;
    };

/**
 * Resolve station.commandCenterRef to an SSH endpoint string.
 *
 * 1. Host registry id with kind=remote + endpoint → that endpoint
 * 2. Host registry id with kind=local → error (cannot pull from self)
 * 3. Otherwise treat the ref as a direct SSH destination (alias / user@host)
 */
export const resolveCommandCenterEndpoint = (
  commandCenterRef: string,
  hosts: ReadonlyArray<CanvasPullHostRow>,
): ResolveCommandCenterEndpointResult => {
  const ref = commandCenterRef.trim();
  if (ref.length === 0) {
    return {
      ok: false,
      detail:
        "Command Center ref is empty — set station.commandCenterRef to a host id or SSH endpoint",
    };
  }
  if (ref.length > 255) {
    return { ok: false, detail: "Command Center ref exceeds 255 characters" };
  }

  const host = hosts.find((row) => row.id === ref);
  if (host) {
    if (host.kind === "local") {
      return {
        ok: false,
        detail:
          `Command Center ref "${ref}" is the local host — register the Command Center as a remote host on this machine, or set an SSH endpoint (user@host or config alias)`,
      };
    }
    const endpoint = host.endpoint?.trim() ?? "";
    if (endpoint.length === 0) {
      return {
        ok: false,
        detail: `host "${ref}" is remote but has no SSH endpoint`,
      };
    }
    return { ok: true, endpoint, source: "host" };
  }

  // Direct endpoint / SSH config alias.
  if (!/^(?!-)[A-Za-z0-9._:@%+\[\]-]+$/.test(ref)) {
    return {
      ok: false,
      detail:
        "Command Center ref must be a registered remote host id or an SSH destination (alias, user@host, or IPv6 literal)",
    };
  }
  return { ok: true, endpoint: ref, source: "direct" };
};

// ---------------------------------------------------------------------------
// Pull result types (structured for doctor / UI)
// ---------------------------------------------------------------------------

export type CanvasPullStatus =
  | "ok"
  | "partial"
  | "skipped_not_remote"
  | "misconfigured"
  | "unreachable"
  | "empty";

export type CanvasPullFileResult = {
  readonly name: string;
  readonly bytes: number;
  /** True when local content differed (or was missing) and was replaced. */
  readonly changed: boolean;
};

export type CanvasPullFileFailure = {
  readonly name: string;
  readonly detail: string;
};

/**
 * Structured result of a Remote pull attempt.
 * On unreachable, local canvases are left untouched (`keptLocal: true`).
 */
export type CanvasPullResult = {
  readonly ok: boolean;
  readonly status: CanvasPullStatus;
  readonly detail: string;
  readonly commandCenterRef: string;
  readonly endpoint?: string;
  readonly pulled: ReadonlyArray<CanvasPullFileResult>;
  readonly failed: ReadonlyArray<CanvasPullFileFailure>;
  /** True when CC was unreachable and last local canvases were retained. */
  readonly keptLocal: boolean;
  readonly pulledAt: string;
};

export const canvasPullResult = (
  partial: Omit<CanvasPullResult, "pulledAt"> & { readonly pulledAt?: string },
): CanvasPullResult => ({
  ...partial,
  pulledAt: partial.pulledAt ?? new Date().toISOString(),
});
