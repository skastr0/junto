import type { CanvasDoc } from "@shared/canvas";
import type { NodeRefKey } from "@shared/node-ref";
import {
  connectedPageRefs,
  findNode,
  isPageNode,
  nodeKind,
  resolveBrowserCaller,
  type BrowserCallerPrincipal,
} from "./authz";
import type { ProcessPrincipal } from "../process-identity";

// Browser process-bind: map a registered process principal onto a canvas
// actor node (agent|herdr) and its edge-reachable pages. Identity
// itself is owned by process-identity (peer PID); this module only does
// canvas resolution.

export type BrowserProcessBindDenial =
  | "not_found"
  | "ambiguous"
  | "caller_wrong_kind"
  | "not_connected";

export type BrowserProcessBindResult =
  | {
      readonly ok: true;
      readonly principal: BrowserCallerPrincipal;
      readonly pageRefs: ReadonlyArray<NodeRefKey>;
    }
  | { readonly ok: false; readonly denial: BrowserProcessBindDenial; readonly message: string };

const matchesProcessPrincipal = (
  node: ReturnType<typeof findNode>,
  principal: ProcessPrincipal,
): boolean => {
  if (!node) return false;
  const kind = nodeKind(node);
  if (principal.kind === "agent") {
    if (kind !== "agent") return false;
    if (principal.nodeId !== undefined) return node.id === principal.nodeId;
    return node.ether?.entity?.name === principal.agentKey;
  }
  if (principal.kind === "terminal") return false;
  if (kind !== "herdr") return false;
  if (principal.nodeId !== undefined) return node.id === principal.nodeId;
  if (principal.paneId !== undefined) {
    return node.ether?.herdr?.paneId === principal.paneId;
  }
  return false;
};

/**
 * Resolve a process principal against one canvas document into a browser
 * caller + edge-reachable page refs.
 */
export const resolveBrowserCallerFromProcess = (
  doc: CanvasDoc,
  canvasName: string,
  principal: ProcessPrincipal,
): BrowserProcessBindResult => {
  if (principal.kind === "terminal") {
    return {
      ok: false,
      denial: "caller_wrong_kind",
      message:
        "native terminal processes cannot wield browser authority — use a live agent or herdr process",
    };
  }

  if (principal.canvasName !== undefined && principal.canvasName !== canvasName) {
    return {
      ok: false,
      denial: "not_found",
      message: `process bound to canvas "${principal.canvasName}", not "${canvasName}"`,
    };
  }

  const hits = doc.nodes.filter((n) => matchesProcessPrincipal(n, principal));
  if (hits.length === 0) {
    return {
      ok: false,
      denial: "not_found",
      message:
        principal.kind === "agent"
          ? `no agent node for ${principal.agentKey ?? "unknown"} on canvas "${canvasName}"`
          : `no herdr node for process on canvas "${canvasName}"`,
    };
  }
  if (hits.length > 1) {
    return {
      ok: false,
      denial: "ambiguous",
      message: `multiple nodes match the connecting process on "${canvasName}"`,
    };
  }

  const node = hits[0]!;
  const caller = resolveBrowserCaller(doc, canvasName, node.id);
  if (!caller.ok || caller.principal.kind === "terminal") {
    return {
      ok: false,
      denial: "caller_wrong_kind",
      message: "matched node is not an admitted browser caller (agent|herdr)",
    };
  }

  const pageRefs = connectedPageRefs(doc, canvasName, node.id);
  if (pageRefs.length === 0) {
    return {
      ok: false,
      denial: "not_connected",
      message: "missing edge between caller and a page node — draw an edge in Vellum",
    };
  }

  // Drop any page ref whose node is no longer a page (paranoia).
  const live = pageRefs.filter((ref) => {
    const id = ref.includes("node=") ? ref.split("node=")[1] : undefined;
    if (!id) return true;
    return isPageNode(findNode(doc, id));
  });

  return {
    ok: true,
    principal: caller.principal,
    pageRefs: live.length > 0 ? live : pageRefs,
  };
};
