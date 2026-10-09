import { readSingleProcessEpochSnapshot } from "./process-epoch";

// Main's record of the processes it started for seats and terminals.
//
//   main registers live PIDs (managed agent seats, native terminals) → principal
//   start-key epoch rejects PID reuse after the original process exits
//
// This is lifecycle bookkeeping, not admission: a caller is admitted by the
// seat generation credential it presents (work/seat-credentials.ts). No
// control socket observes the connecting process or walks its ancestry.

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
  "@junto/ProcessIdentityBinding",
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

/**
 * Stable process start identity for epoch checks. The same single-pid
 * observation the process-epoch capture just took: `startKey` is that row's
 * `lstart`, not a second `ps`. A later turn reads again, so pid reuse still
 * fails the comparison.
 */
export const readProcessStartKey = (pid: number): string | undefined => {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const startKey = readSingleProcessEpochSnapshot(pid)?.find((row) => row.pid === pid)?.startKey;
  return startKey === undefined || startKey.length === 0 ? undefined : startKey;
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
}

export const makeProcessIdentityMap = (
  options: ProcessIdentityMapOptions = {},
): ProcessIdentityMap => {
  const byPid = new Map<number, BoundRecord>();
  const bindings = new WeakMap<ProcessIdentityBinding, BoundRecord>();
  const listeners = new Set<(principal: ProcessPrincipal) => void>();
  const isAlive = options.processAlive ?? processAlive;
  const startKeyOf = options.readProcessStartKey ?? readProcessStartKey;

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

  return {
    bind,
    bindGeneration,
    unbind,
    unbindGeneration,
    unbindPrincipal,
    unbindAgentKey,
    unbindTerminalBinding,
    resolve: resolveLive,
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

/**
 * What a caller hears once its seat has moved on to a fresh session and it
 * is only being allowed to finish its turn.
 */
export const OFFBOARDED_SESSION_MESSAGE =
  "This session has offboarded. Its seat has moved on to a fresh session.";
