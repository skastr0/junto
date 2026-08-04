import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import type { ProcessPrincipal } from "../process-identity";
import { matchesProcessPrincipal } from "../process-principal-match";
import { findNode } from "./authz";

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
    if (node && matchesProcessPrincipal(node, principal)) {
      return { ok: true, caller: { canvasName, nodeId: node.id, node, doc } };
    }
  }
  const hits = doc.nodes.filter((n) => matchesProcessPrincipal(n, principal));
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
        "this process matches more than one agent node across live canvases",
    };
  }
  return { ok: true, caller: hits[0]! };
};
