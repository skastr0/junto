import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Either } from "effect";
import { decodeCanvasDoc, type CanvasDoc, type CanvasNode } from "@shared/canvas";
import type { ProcessPrincipal } from "../process-identity";
import { findNode, nodeKind } from "./authz";

// Resolve a process-bound principal to a concrete canvas caller node.
// Agents never claim a nodeRef — main finds the live agent|herdr card(s).

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

const matchesPrincipal = (node: CanvasNode, principal: ProcessPrincipal): boolean => {
  const kind = nodeKind(node);
  if (principal.kind === "agent") {
    if (kind !== "agent") return false;
    if (principal.nodeId !== undefined) return node.id === principal.nodeId;
    return node.ether?.entity?.name === principal.agentKey;
  }
  if (kind !== "herdr") return false;
  if (principal.nodeId !== undefined) return node.id === principal.nodeId;
  if (principal.paneId !== undefined) {
    return node.ether?.herdr?.paneId === principal.paneId;
  }
  return false;
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
      message:
        principal.kind === "agent"
          ? `no agent node for ${principal.agentKey ?? "unknown"} on canvas "${canvasName}"`
          : `no herdr node for pane ${principal.paneId ?? "unknown"} on canvas "${canvasName}"`,
    };
  }
  if (hits.length > 1) {
    return {
      ok: false,
      code: "ambiguous",
      message: `multiple canvas nodes match the connecting process on "${canvasName}"`,
    };
  }
  const node = hits[0]!;
  return { ok: true, caller: { canvasName, nodeId: node.id, node, doc } };
};

/**
 * Scan ~/.vellum/canvases for a unique agent|herdr node matching the principal.
 * Used when the process was bound by agentKey/paneId without a canvas anchor.
 */
export const resolveCallerAcrossCanvases = async (
  canvasesDir: string,
  principal: ProcessPrincipal,
): Promise<CallerResolveResult> => {
  if (principal.canvasName !== undefined) {
    try {
      const path = join(canvasesDir, `${principal.canvasName}.canvas`);
      const raw = await readFile(path, "utf8");
      const decoded = decodeCanvasDoc(JSON.parse(raw));
      if (Either.isLeft(decoded)) {
        return { ok: false, code: "not_found", message: "bound canvas is unreadable" };
      }
      return resolveCallerOnDoc(decoded.right, principal.canvasName, principal);
    } catch {
      return { ok: false, code: "not_found", message: "bound canvas is missing" };
    }
  }

  let names: string[];
  try {
    names = (await readdir(canvasesDir)).filter((n) => n.endsWith(".canvas"));
  } catch {
    return { ok: false, code: "not_found", message: "canvases directory unavailable" };
  }

  const hits: ResolvedWorkCaller[] = [];
  for (const file of names.sort()) {
    const canvasName = file.slice(0, -".canvas".length);
    try {
      const raw = await readFile(join(canvasesDir, file), "utf8");
      const decoded = decodeCanvasDoc(JSON.parse(raw));
      if (Either.isLeft(decoded)) continue;
      const resolved = resolveCallerOnDoc(decoded.right, canvasName, principal);
      if (resolved.ok) hits.push(resolved.caller);
    } catch {
      // skip unreadable
    }
  }

  if (hits.length === 0) {
    return {
      ok: false,
      code: "not_found",
      message:
        principal.kind === "agent"
          ? `no agent node for ${principal.agentKey ?? "unknown"} on any canvas`
          : `no herdr node for pane ${principal.paneId ?? "unknown"} on any canvas`,
    };
  }
  if (hits.length > 1) {
    return {
      ok: false,
      code: "ambiguous",
      message:
        "connecting process matches multiple canvas nodes — keep one agent|herdr card per process",
    };
  }
  return { ok: true, caller: hits[0]! };
};
