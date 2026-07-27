import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import type { ProcessPrincipal } from "../process-identity";
import { findNode, nodeKind } from "./authz";
import { resolveSpec, roleOf } from "@shared/physics";
import { isGroup } from "@shared/graph";

// Resolve a process-bound principal to a concrete canvas caller node. Caller
// identity comes only from the main-owned process registration.
//
// Doctrine: resolution uses live in-process canvas authority only. Raw disk
// scans must never mint capability from external file edits.

export interface ResolvedWorkCaller {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly node: CanvasNode;
  readonly doc: CanvasDoc;
}

export type CallerResolveFailure =
  | { readonly ok: false; readonly code: "not_found"; readonly message: string }
  | { readonly ok: false; readonly code: "ambiguous"; readonly message: string };

export type CallerResolveResult =
  | { readonly ok: true; readonly caller: ResolvedWorkCaller }
  | CallerResolveFailure;

/**
 * Seat match for a process-bound principal.
 * When both id and role key are present, both must match (no id-only forge).
 */
export const matchesPrincipal = (
  node: CanvasNode,
  principal: ProcessPrincipal,
): boolean => {
  // Role decides participation — one actor kind, asked of physics, never a
  // kind string compared here.
  if (roleOf(resolveSpec({ kind: nodeKind(node), isGroup: isGroup(node) })) !== "actor") {
    return false;
  }
  if (principal.nodeId !== undefined && node.id !== principal.nodeId) return false;
  if (
    principal.agentKey !== undefined &&
    node.ether?.entity?.name !== principal.agentKey
  ) {
    return false;
  }
  if (
    principal.bindingId !== undefined &&
    node.ether?.terminal?.bindingId !== principal.bindingId
  ) {
    return false;
  }
  // Need at least one positive anchor.
  return (
    principal.nodeId !== undefined ||
    principal.agentKey !== undefined ||
    principal.bindingId !== undefined
  );
};

/** Resolve against one already-loaded document (tests / hot path). */
export const resolveCallerOnDoc = (
  doc: CanvasDoc,
  canvasName: string,
  principal: ProcessPrincipal,
): CallerResolveResult => {
  if (principal.canvasName !== undefined && principal.canvasName !== canvasName) {
    return {
      ok: false,
      code: "not_found",
      message: `process is bound to canvas "${principal.canvasName}", not "${canvasName}"`,
    };
  }
  if (principal.nodeId !== undefined && principal.canvasName === canvasName) {
    const node = findNode(doc, principal.nodeId);
    if (node && matchesPrincipal(node, principal)) {
      return { ok: true, caller: { canvasName, nodeId: node.id, node, doc } };
    }
  }
  const hits = doc.nodes.filter((n) => matchesPrincipal(n, principal));
  if (hits.length === 0) {
    return {
      ok: false,
      code: "not_found",
      message: `no agent node for ${principal.agentKey ?? principal.bindingId ?? "unknown"} on canvas "${canvasName}"`,
    };
  }
  if (hits.length > 1) {
    return {
      ok: false,
      code: "ambiguous",
      message: `multiple canvas nodes match the connecting process on canvas "${canvasName}"`,
    };
  }
  const node = hits[0]!;
  return { ok: true, caller: { canvasName, nodeId: node.id, node, doc } };
};

/**
 * Resolve against the live authority document set (not raw disk).
 * Used when the process was bound by agentKey/paneId without a canvas anchor.
 */
export const resolveCallerAcrossCanvases = (
  documents: ReadonlyArray<{ readonly canvasName: string; readonly doc: CanvasDoc }>,
  principal: ProcessPrincipal,
): CallerResolveResult => {
  if (principal.canvasName !== undefined) {
    const match = documents.find((d) => d.canvasName === principal.canvasName);
    if (!match) {
      return { ok: false, code: "not_found", message: "bound canvas is missing from live authority" };
    }
    return resolveCallerOnDoc(match.doc, match.canvasName, principal);
  }

  const hits: ResolvedWorkCaller[] = [];
  for (const { canvasName, doc } of documents) {
    const resolved = resolveCallerOnDoc(doc, canvasName, principal);
    if (resolved.ok) hits.push(resolved.caller);
  }

  if (hits.length === 0) {
    return {
      ok: false,
      code: "not_found",
      message: `no agent node for ${principal.agentKey ?? principal.bindingId ?? "unknown"} on any live canvas`,
    };
  }
  if (hits.length > 1) {
    return {
      ok: false,
      code: "ambiguous",
      message:
        "connecting process matches multiple canvas nodes — keep one actor card per process",
    };
  }
  return { ok: true, caller: hits[0]! };
};
