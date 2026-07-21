import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Socket } from "node:net";

// Process-bind identity for local agent tooling (work + browser control).
//
// Canonical model:
//   main registers live PIDs (ACP child, herdr pane processes) → principal
//   control sockets read the Unix peer PID (not a client-supplied claim)
//   admission walks the peer PID then its ancestors (CLI may be a grandchild)
//   edges on the canvas grant scope; agents never present a forgeable nodeRef
//
// Client-supplied nodeRef / capability secrets are not identity.

export type ProcessPrincipalKind = "agent" | "herdr";

export interface ProcessPrincipal {
  readonly kind: ProcessPrincipalKind;
  /** Hermes agent key (`local:profile`) when kind is agent. */
  readonly agentKey?: string;
  /** Herdr pane id when kind is herdr. */
  readonly paneId?: string;
  /** Optional canvas anchor when known at bind time. */
  readonly canvasName?: string;
  readonly nodeId?: string;
}

export interface ProcessIdentityMap {
  readonly bind: (pid: number, principal: ProcessPrincipal) => void;
  readonly unbind: (pid: number) => void;
  readonly unbindPrincipal: (match: ProcessPrincipal) => void;
  readonly resolve: (pid: number) => ProcessPrincipal | undefined;
  /** Walk pid → ppid … looking for a bound ancestor (inclusive). */
  readonly resolveInTree: (pid: number, maxDepth?: number) => ProcessPrincipal | undefined;
  readonly clear: () => void;
  readonly size: () => number;
  readonly snapshot: () => ReadonlyArray<{ readonly pid: number; readonly principal: ProcessPrincipal }>;
}

const samePrincipal = (a: ProcessPrincipal, b: ProcessPrincipal): boolean =>
  a.kind === b.kind &&
  a.agentKey === b.agentKey &&
  a.paneId === b.paneId &&
  a.canvasName === b.canvasName &&
  a.nodeId === b.nodeId;

export const makeProcessIdentityMap = (): ProcessIdentityMap => {
  const byPid = new Map<number, ProcessPrincipal>();

  const bind = (pid: number, principal: ProcessPrincipal): void => {
    if (!Number.isInteger(pid) || pid <= 0) return;
    if (principal.kind === "agent" && !principal.agentKey) return;
    if (principal.kind === "herdr" && !principal.paneId && !principal.nodeId) return;
    byPid.set(pid, Object.freeze({ ...principal }));
  };

  const unbind = (pid: number): void => {
    byPid.delete(pid);
  };

  const unbindPrincipal = (match: ProcessPrincipal): void => {
    for (const [pid, principal] of byPid) {
      if (samePrincipal(principal, match)) byPid.delete(pid);
    }
  };

  const resolve = (pid: number): ProcessPrincipal | undefined => byPid.get(pid);

  const resolveInTree = (pid: number, maxDepth = 8): ProcessPrincipal | undefined => {
    let current: number | undefined = pid;
    for (let depth = 0; depth < maxDepth && current !== undefined && current > 0; depth += 1) {
      const hit = byPid.get(current);
      if (hit !== undefined) return hit;
      current = readParentPid(current);
    }
    return undefined;
  };

  return {
    bind,
    unbind,
    unbindPrincipal,
    resolve,
    resolveInTree,
    clear: () => byPid.clear(),
    size: () => byPid.size,
    snapshot: () =>
      [...byPid.entries()]
        .map(([pid, principal]) => ({ pid, principal }))
        .sort((a, b) => a.pid - b.pid),
  };
};

/** Shared main-process registry. Control planes and chat/herdr share one map. */
let sharedMap: ProcessIdentityMap | undefined;

export const getProcessIdentityMap = (): ProcessIdentityMap => {
  if (sharedMap === undefined) sharedMap = makeProcessIdentityMap();
  return sharedMap;
};

/** Test seam: replace the shared map (or pass undefined to reset). */
export const setProcessIdentityMapForTests = (map: ProcessIdentityMap | undefined): void => {
  sharedMap = map;
};

export const readParentPid = (pid: number): number | undefined => {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "ppid="], {
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

const helperCandidates = (): ReadonlyArray<string> => {
  const here = dirname(fileURLToPath(import.meta.url));
  // Dev: src/main/vellum → repo scripts/
  // Built: out/main/… → still reach repo scripts or app resources
  return [
    join(here, "../../../scripts/unix-peer-pid.py"),
    join(here, "../../../../scripts/unix-peer-pid.py"),
    join(process.cwd(), "scripts/unix-peer-pid.py"),
  ];
};

const resolveHelper = (): string | undefined => {
  for (const candidate of helperCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
};

const socketFd = (socket: Socket): number | undefined => {
  const handle = (socket as unknown as { _handle?: { fd?: number } })._handle;
  const fd = handle?.fd;
  return typeof fd === "number" && Number.isInteger(fd) && fd >= 0 ? fd : undefined;
};

export type PeerPidReader = (socket: Socket) => number | undefined;

/**
 * Read the peer PID of a connected Unix-domain socket.
 * Injectable for tests; production uses scripts/unix-peer-pid.py on fd 0.
 */
export const readUnixPeerPid: PeerPidReader = (socket) => {
  const fd = socketFd(socket);
  if (fd === undefined) return undefined;
  const helper = resolveHelper();
  if (helper === undefined) return undefined;
  try {
    const result = spawnSync(process.env.VELLUM_PYTHON?.trim() || "python3", [helper], {
      stdio: [fd, "pipe", "pipe"],
      encoding: "utf8",
      timeout: 500,
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
  | "peer_pid_unavailable"
  | "process_unbound"
  | "wrong_kind";

export type ProcessIdentityResult =
  | { readonly ok: true; readonly peerPid: number; readonly principal: ProcessPrincipal }
  | { readonly ok: false; readonly denial: ProcessIdentityDenial; readonly message: string };

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
        "connecting process is not a registered agent or herdr process — open the agent in Vellum first",
    };
  }
  return { ok: true, peerPid, principal };
};
