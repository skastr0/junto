import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Socket } from "node:net";
import { resolveSystemPs } from "./platform-executables";

// Process-bind identity for local agent tooling (work + browser control).
//
// Canonical model:
//   main registers live PIDs (managed agent seats, native terminals) → principal
//   control sockets read the Unix peer PID (not a client-supplied claim)
//   admission walks the peer PID then its ancestors (CLI may be a grandchild)
//   start-key epoch rejects PID reuse after the original process exits
//   edges on the canvas grant scope; agents never present a forgeable nodeRef
//
// Client-supplied nodeRef / capability secrets are not identity.

/**
 * One principal. There is one actor kind, so there is one principal shape —
 * no discriminant, and every anchor optional but at least one required by
 * `bind`. (Was three kinds x three optional ids; see the consolidation plan D7.)
 */
export interface ProcessPrincipal {
  /** Agent key (`local:profile`) of the seat this process belongs to. */
  readonly agentKey?: string;
  /** Stable managed-terminal binding for the seat. */
  readonly bindingId?: string;
  /** Optional canvas anchor when known at bind time. */
  readonly canvasName?: string;
  readonly nodeId?: string;
}

interface BoundRecord {
  readonly principal: ProcessPrincipal;
  /** OS process start identity; admit fails if the live process differs. */
  readonly startKey: string;
}

const ProcessIdentityBindingTypeId: unique symbol = Symbol(
  "@vellum/ProcessIdentityBinding",
);

/**
 * Exact authority to retire one PID/start-key/principal generation. A late
 * terminal witness cannot use it to erase a replacement generation that
 * reused the same numeric PID.
 */
export interface ProcessIdentityBinding {
  readonly [ProcessIdentityBindingTypeId]: typeof ProcessIdentityBindingTypeId;
  readonly pid: number;
  readonly principal: ProcessPrincipal;
  readonly startKey: string;
}

export interface ProcessIdentityMap {
  readonly bind: (pid: number, principal: ProcessPrincipal) => boolean;
  readonly bindGeneration: (
    pid: number,
    principal: ProcessPrincipal,
  ) => ProcessIdentityBinding | undefined;
  readonly unbind: (pid: number) => void;
  readonly unbindGeneration: (binding: ProcessIdentityBinding) => boolean;
  readonly unbindPrincipal: (match: ProcessPrincipal) => void;
  /** Drop every bind for this agentKey (before rebinding a new ACP child). */
  readonly unbindAgentKey: (agentKey: string) => void;
  /** Drop every bind for this native terminal binding. */
  readonly unbindTerminalBinding: (bindingId: string) => void;
  readonly resolve: (pid: number) => ProcessPrincipal | undefined;
  /** Walk pid → ppid … looking for a bound ancestor (inclusive). */
  readonly resolveInTree: (
    pid: number,
    maxDepth?: number,
  ) => ProcessPrincipal | undefined;
  readonly clear: () => void;
  readonly size: () => number;
  readonly snapshot: () => ReadonlyArray<{
    readonly pid: number;
    readonly principal: ProcessPrincipal;
    readonly startKey: string;
  }>;
  /** Main-owned lifecycle signal; callers never provide identity epochs. */
  readonly subscribe: (
    listener: (principal: ProcessPrincipal) => void,
  ) => () => void;
}

const samePrincipal = (a: ProcessPrincipal, b: ProcessPrincipal): boolean =>
  a.agentKey === b.agentKey &&
  a.bindingId === b.bindingId &&
  a.canvasName === b.canvasName &&
  a.nodeId === b.nodeId;

/** Stable process start identity for epoch checks (cross-platform via `ps`). */
export const readProcessStartKey = (pid: number): string | undefined => {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const ps = resolveSystemPs();
  if (ps === undefined) return undefined;
  try {
    // lstart is stable for the life of the process on macOS/Linux ps.
    const result = spawnSync(ps, ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 500,
    });
    if (result.status !== 0) return undefined;
    const raw = (result.stdout ?? "").trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
};

export const processAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export interface ProcessIdentityMapOptions {
  readonly processAlive?: (pid: number) => boolean;
  readonly readProcessStartKey?: (pid: number) => string | undefined;
  /** Deterministic ancestry seam for tests; production uses the sealed ps reader. */
  readonly readParentPid?: (pid: number) => number | undefined;
}

export const makeProcessIdentityMap = (
  options: ProcessIdentityMapOptions = {},
): ProcessIdentityMap => {
  const byPid = new Map<number, BoundRecord>();
  const bindings = new WeakMap<ProcessIdentityBinding, BoundRecord>();
  const listeners = new Set<(principal: ProcessPrincipal) => void>();
  const isAlive = options.processAlive ?? processAlive;
  const startKeyOf = options.readProcessStartKey ?? readProcessStartKey;
  const parentOf = options.readParentPid ?? readParentPid;

  const notify = (principal: ProcessPrincipal): void => {
    for (const listener of listeners) listener(principal);
  };

  const unbind = (pid: number): void => {
    const existing = byPid.get(pid);
    if (existing === undefined) return;
    byPid.delete(pid);
    notify(existing.principal);
  };

  const bindRecord = (
    pid: number,
    principal: ProcessPrincipal,
  ): BoundRecord | undefined => {
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    // At least one anchor, or the principal names nobody. A binding-only
    // principal must additionally be canvas-pinned: an agent key is unique to a
    // seat, a raw binding is not, so it needs the node to be unambiguous.
    if (!principal.agentKey) {
      if (!principal.bindingId || !principal.canvasName || !principal.nodeId) {
        return undefined;
      }
    }
    if (!isAlive(pid)) return undefined;
    const startKey = startKeyOf(pid);
    if (startKey === undefined) return undefined;
    const existing = byPid.get(pid);
    if (
      existing !== undefined &&
      existing.startKey === startKey &&
      !samePrincipal(existing.principal, principal)
    ) {
      // Live PID already bound to a different principal — refuse overwrite.
      return undefined;
    }
    const record = Object.freeze({
      principal: Object.freeze({ ...principal }),
      startKey,
    });
    byPid.set(pid, record);
    return record;
  };

  const bind = (pid: number, principal: ProcessPrincipal): boolean =>
    bindRecord(pid, principal) !== undefined;

  const bindGeneration = (
    pid: number,
    principal: ProcessPrincipal,
  ): ProcessIdentityBinding | undefined => {
    const record = bindRecord(pid, principal);
    if (record === undefined) return undefined;
    const binding: ProcessIdentityBinding = {
      [ProcessIdentityBindingTypeId]: ProcessIdentityBindingTypeId,
      pid,
      principal: record.principal,
      startKey: record.startKey,
    };
    Object.freeze(binding);
    bindings.set(binding, record);
    return binding;
  };

  const unbindGeneration = (binding: ProcessIdentityBinding): boolean => {
    const record = bindings.get(binding);
    if (record === undefined) return false;
    bindings.delete(binding);
    if (byPid.get(binding.pid) !== record) return false;
    unbind(binding.pid);
    return true;
  };

  const unbindPrincipal = (match: ProcessPrincipal): void => {
    for (const [pid, record] of byPid) {
      if (samePrincipal(record.principal, match)) unbind(pid);
    }
  };

  const unbindAgentKey = (agentKey: string): void => {
    for (const [pid, record] of byPid) {
      if (record.principal.agentKey === agentKey) {
        unbind(pid);
      }
    }
  };

  const unbindTerminalBinding = (bindingId: string): void => {
    for (const [pid, record] of byPid) {
      if (record.principal.bindingId === bindingId) {
        unbind(pid);
      }
    }
  };

  const resolveLive = (pid: number): ProcessPrincipal | undefined => {
    const record = byPid.get(pid);
    if (record === undefined) return undefined;
    if (!isAlive(pid)) {
      unbind(pid);
      return undefined;
    }
    const startKey = startKeyOf(pid);
    if (startKey === undefined || startKey !== record.startKey) {
      unbind(pid);
      return undefined;
    }
    return record.principal;
  };

  const resolveInTree = (
    pid: number,
    maxDepth = 8,
  ): ProcessPrincipal | undefined => {
    let current: number | undefined = pid;
    for (
      let depth = 0;
      depth < maxDepth && current !== undefined && current > 0;
      depth += 1
    ) {
      const hit = resolveLive(current);
      if (hit !== undefined) return hit;
      current = parentOf(current);
    }
    return undefined;
  };

  return {
    bind,
    bindGeneration,
    unbind,
    unbindGeneration,
    unbindPrincipal,
    unbindAgentKey,
    unbindTerminalBinding,
    resolve: resolveLive,
    resolveInTree,
    clear: () => {
      for (const pid of [...byPid.keys()]) unbind(pid);
    },
    size: () => byPid.size,
    snapshot: () =>
      [...byPid.entries()]
        .map(([pid, record]) => ({
          pid,
          principal: record.principal,
          startKey: record.startKey,
        }))
        .sort((a, b) => a.pid - b.pid),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

/** Shared main-process registry. Every control plane shares one map. */
let sharedMap: ProcessIdentityMap | undefined;

export const getProcessIdentityMap = (): ProcessIdentityMap => {
  if (sharedMap === undefined) sharedMap = makeProcessIdentityMap();
  return sharedMap;
};

/** Test seam: replace the shared map (or pass undefined to reset). */
export const setProcessIdentityMapForTests = (
  map: ProcessIdentityMap | undefined,
): void => {
  sharedMap = map;
};

export const readParentPid = (pid: number): number | undefined => {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const ps = resolveSystemPs();
  if (ps === undefined) return undefined;
  try {
    const result = spawnSync(ps, ["-p", String(pid), "-o", "ppid="], {
      encoding: "utf8",
      timeout: 500,
    });
    if (result.status !== 0) return undefined;
    const raw = (result.stdout ?? "").trim();
    if (!/^[1-9][0-9]*$/.test(raw)) return undefined;
    const ppid = Number(raw);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : undefined;
  } catch {
    return undefined;
  }
};

// ---------------------------------------------------------------------------
// Peer PID helper — sealed path only (no cwd discovery)

const HELPER_NAME = "unix-peer-pid.py";
/** Trusted interpreters only (absolute). No PATH / VELLUM_COMMAND_PYTHON in product. */
const TRUSTED_PYTHON = ["/usr/bin/python3", "/bin/python3"] as const;

/** Absolute directories that may contain the peer-PID helper (set at app start). */
let resourcesRoots: ReadonlyArray<string> = [];

/**
 * Configure trusted roots for the peer-PID helper.
 * Production: `process.resourcesPath/bin` (electron-builder extraResources).
 * Dev: repo `scripts/` only via explicit absolute path from main.
 */
export const configurePeerPidHelperRoots = (
  roots: ReadonlyArray<string>,
): void => {
  resourcesRoots = roots
    .filter(
      (root) => typeof root === "string" && root.length > 0 && isAbsolute(root),
    )
    .map((root) => normalize(root));
};

export const peerPidHelperRootsForTests = (): ReadonlyArray<string> =>
  resourcesRoots;

const resolveHelper = (): string | undefined => {
  for (const root of resourcesRoots) {
    const candidate = join(root, HELPER_NAME);
    if (existsSync(candidate)) return candidate;
  }
  // Dev fallback: only paths relative to this module that resolve under the
  // repository scripts/ directory — never process.cwd().
  const here = dirname(fileURLToPath(import.meta.url));
  const devCandidates = [
    join(here, "../../../scripts", HELPER_NAME),
    join(here, "../../../../scripts", HELPER_NAME),
  ];
  for (const candidate of devCandidates) {
    const absolute = resolve(candidate);
    if (
      !absolute.endsWith(`/scripts/${HELPER_NAME}`) &&
      !absolute.endsWith(`\\scripts\\${HELPER_NAME}`)
    ) {
      continue;
    }
    if (existsSync(absolute)) return absolute;
  }
  return undefined;
};

const resolveTrustedPython = (): string | undefined => {
  for (const candidate of TRUSTED_PYTHON) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
};

const socketFd = (socket: Socket): number | undefined => {
  const handle = (socket as unknown as { _handle?: { fd?: number } })._handle;
  const fd = handle?.fd;
  return typeof fd === "number" && Number.isInteger(fd) && fd >= 0
    ? fd
    : undefined;
};

export type PeerPidReader = (socket: Socket) => number | undefined;

/**
 * Read the peer PID of a connected Unix-domain socket.
 * Injectable for tests; production uses the sealed helper on fd 0.
 */
export const readUnixPeerPid: PeerPidReader = (socket) => {
  const fd = socketFd(socket);
  if (fd === undefined) return undefined;
  const helper = resolveHelper();
  const python = resolveTrustedPython();
  if (helper === undefined || python === undefined) return undefined;
  try {
    // Hang-safety net only (not a security bound): a trusted, sealed,
    // near-instant interpreter start. 500ms was tight enough to misfire as
    // "no peer PID" under ordinary host CPU contention rather than an actual
    // stuck helper; widen the net without weakening what is trusted.
    const result = spawnSync(python, [helper], {
      stdio: [fd, "pipe", "pipe"],
      encoding: "utf8",
      timeout: 2_000,
    });
    if (result.status !== 0) return undefined;
    const raw = (result.stdout ?? "").trim();
    if (!/^[1-9][0-9]*$/.test(raw)) return undefined;
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
};

export type ProcessIdentityDenial =
  "peer_pid_unavailable" | "process_unbound" | "wrong_kind";

export type ProcessIdentityResult =
  | {
      readonly ok: true;
      readonly peerPid: number;
      readonly principal: ProcessPrincipal;
    }
  | {
      readonly ok: false;
      readonly denial: ProcessIdentityDenial;
      readonly message: string;
    };

export const admitProcessIdentity = (
  socket: Socket,
  map: ProcessIdentityMap = getProcessIdentityMap(),
  readPeer: PeerPidReader = readUnixPeerPid,
): ProcessIdentityResult => {
  const peerPid = readPeer(socket);
  if (peerPid === undefined) {
    return {
      ok: false,
      denial: "peer_pid_unavailable",
      message:
        "could not attribute connecting process — process-bind requires a Unix peer PID",
    };
  }
  const principal = map.resolveInTree(peerPid);
  if (principal === undefined) {
    return {
      ok: false,
      denial: "process_unbound",
      message:
        "connecting process is not a registered agent process — open the agent in Vellum Command first",
    };
  }
  return { ok: true, peerPid, principal };
};
