import type { CanvasDoc } from "@shared/canvas";
import { parseNodeRef, type NodeRef } from "@shared/node-ref";
import {
  resolveBrowserCaller,
  type BrowserAuthzDenial,
  type BrowserCallerPrincipal,
  browserAuthzMessage,
} from "./authz";

// Process-bind: map a local browser-CLI caller to a canvas agent|herdr node.
//
// Product path (BA-001):
//   1. Claim identity via VELLUM_NODE_REF (same env as the work plane).
//   2. Optionally reinforce with a main-owned PID map (ACP child / herdr
//      process-info) when the connecting process can be attributed.
//   3. Edges on the canvas grant page scope — no capability ceremony, no
//      spawn-sibling delivery, no allowlist of stock agents.
//
// Transport token remains the owner-local DoS/pre-auth gate. Process-bind is
// the authority principal for edge-scoped browser ops.

export const PROCESS_BIND_NODE_REF_ENV = "VELLUM_NODE_REF";

export type ProcessBindDenial =
  | BrowserAuthzDenial
  | "invalid_node_ref"
  | "pid_mismatch"
  | "pid_unbound";

export interface ProcessBindResolveOk {
  readonly ok: true;
  readonly principal: BrowserCallerPrincipal;
  readonly ref: NodeRef;
  /** How the principal was established. */
  readonly binding: "node_ref" | "pid" | "node_ref+pid";
}

export interface ProcessBindResolveErr {
  readonly ok: false;
  readonly denial: ProcessBindDenial;
  readonly message: string;
}

export type ProcessBindResolveResult = ProcessBindResolveOk | ProcessBindResolveErr;

export interface ProcessBindMap {
  /** Register a live process as a canvas principal (ACP child / herdr pane). */
  readonly bind: (pid: number, principalKey: string) => void;
  readonly unbind: (pid: number) => void;
  readonly unbindPrincipal: (principalKey: string) => void;
  readonly resolve: (pid: number) => string | undefined;
  readonly clear: () => void;
  readonly size: () => number;
}

/** Stable map key for a principal (matches BrowserCallerPrincipal.auditOwnerId). */
export const principalKey = (canvasName: string, nodeId: string): string =>
  `edge:${canvasName}/${nodeId}`;

export const makeProcessBindMap = (): ProcessBindMap => {
  const byPid = new Map<number, string>();
  const pidsByPrincipal = new Map<string, Set<number>>();

  const bind = (pid: number, key: string): void => {
    if (!Number.isInteger(pid) || pid <= 0 || key.length === 0) return;
    const previous = byPid.get(pid);
    if (previous !== undefined && previous !== key) {
      const set = pidsByPrincipal.get(previous);
      set?.delete(pid);
      if (set !== undefined && set.size === 0) pidsByPrincipal.delete(previous);
    }
    byPid.set(pid, key);
    let set = pidsByPrincipal.get(key);
    if (set === undefined) {
      set = new Set();
      pidsByPrincipal.set(key, set);
    }
    set.add(pid);
  };

  const unbind = (pid: number): void => {
    const key = byPid.get(pid);
    if (key === undefined) return;
    byPid.delete(pid);
    const set = pidsByPrincipal.get(key);
    set?.delete(pid);
    if (set !== undefined && set.size === 0) pidsByPrincipal.delete(key);
  };

  const unbindPrincipal = (key: string): void => {
    const set = pidsByPrincipal.get(key);
    if (set === undefined) return;
    for (const pid of set) byPid.delete(pid);
    pidsByPrincipal.delete(key);
  };

  return {
    bind,
    unbind,
    unbindPrincipal,
    resolve: (pid) => byPid.get(pid),
    clear: () => {
      byPid.clear();
      pidsByPrincipal.clear();
    },
    size: () => byPid.size,
  };
};

const fail = (denial: ProcessBindDenial, message: string): ProcessBindResolveErr => ({
  ok: false,
  denial,
  message,
});

/**
 * Resolve a browser caller from an explicit node ref (+ optional peer pid).
 * Pure with respect to the document; the optional map only reinforces identity.
 */
export const resolveProcessBoundCaller = (
  doc: CanvasDoc,
  nodeRef: string,
  options: {
    readonly peerPid?: number;
    readonly processMap?: ProcessBindMap;
    /** When true, peerPid must be present and map to this principal. */
    readonly requirePidBind?: boolean;
  } = {},
): ProcessBindResolveResult => {
  const parsed = parseNodeRef(nodeRef);
  if (!parsed.ok) {
    return fail("invalid_node_ref", parsed.error.message);
  }
  const { canvasName, nodeId } = parsed.value;
  const caller = resolveBrowserCaller(doc, canvasName, nodeId);
  if (!caller.ok) {
    return fail(caller.denial, browserAuthzMessage(caller.denial));
  }

  const key = principalKey(canvasName, nodeId);
  const peerPid = options.peerPid;
  const map = options.processMap;
  const mapped =
    peerPid !== undefined && map !== undefined ? map.resolve(peerPid) : undefined;

  if (options.requirePidBind) {
    if (peerPid === undefined || map === undefined) {
      return fail("pid_unbound", "process identity required for this admission path");
    }
    if (mapped === undefined) {
      return fail("pid_unbound", "connecting process is not bound to a canvas agent");
    }
    if (mapped !== key) {
      return fail("pid_mismatch", "connecting process is bound to a different agent");
    }
    return {
      ok: true,
      principal: caller.principal,
      ref: parsed.value,
      binding: "node_ref+pid",
    };
  }

  if (mapped !== undefined && mapped !== key) {
    return fail("pid_mismatch", "connecting process is bound to a different agent");
  }

  return {
    ok: true,
    principal: caller.principal,
    ref: parsed.value,
    binding: mapped === key ? "node_ref+pid" : "node_ref",
  };
};

/**
 * Resolve solely from peer PID when the process map knows the principal and
 * the canvas still has that node. Used when the CLI omits nodeRef but the
 * ACP/herdr child was registered at spawn.
 */
export const resolveProcessBoundCallerByPid = (
  doc: CanvasDoc,
  canvasName: string,
  peerPid: number,
  processMap: ProcessBindMap,
): ProcessBindResolveResult => {
  const key = processMap.resolve(peerPid);
  if (key === undefined) {
    return fail("pid_unbound", "connecting process is not bound to a canvas agent");
  }
  const match = /^edge:([^/]+)\/(.+)$/.exec(key);
  if (match === null) {
    return fail("pid_unbound", "process bind map holds an invalid principal key");
  }
  const boundCanvas = match[1]!;
  const nodeId = match[2]!;
  if (boundCanvas !== canvasName) {
    // Caller must re-present the correct canvas via nodeRef; PID alone is
    // canvas-scoped only when the map key matches the document being read.
    return fail("pid_mismatch", "process is bound to a different canvas");
  }
  const caller = resolveBrowserCaller(doc, canvasName, nodeId);
  if (!caller.ok) {
    return fail(caller.denial, browserAuthzMessage(caller.denial));
  }
  return {
    ok: true,
    principal: caller.principal,
    ref: { canvasName, nodeId },
    binding: "pid",
  };
};
