import type { CanvasDoc } from "@shared/canvas";
import type { NodeRefKey } from "@shared/node-ref";
import { parseNodeRef } from "@shared/node-ref";
import type { CapabilityViewOptions } from "@shared/physics";
import {
  connectedPageRefs,
  findNode,
  isPageNode,
  resolveBrowserCaller,
  type BrowserCallerPrincipal,
} from "./authz";
import type { ProcessPrincipal } from "../process-identity";
import { matchesProcessPrincipal } from "../process-principal-match";

// Browser process-bind: map a registered process principal onto a canvas
// actor node and its edge-reachable pages. Identity itself is owned by
// process-identity (peer PID); this module only does canvas resolution.
//
// Eligibility is the factory role of the matched node (`resolveBrowserCaller`
// → `isBrowserCallerNode`). This module keeps no kind ACL of its own: a node
// physics calls an actor is a browser caller, and a kind that stops being an
// actor stops being one here with no edit to this file.

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

/**
 * Resolve a process principal against one canvas document into a browser
 * caller + edge-reachable page refs.
 * `viewOptions` carries placement topology when the origin knows its CC host.
 */
export const resolveBrowserCallerFromProcess = (
  doc: CanvasDoc,
  canvasName: string,
  principal: ProcessPrincipal,
  viewOptions?: CapabilityViewOptions,
): BrowserProcessBindResult => {
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
      message: `no agent node for ${principal.agentKey ?? principal.bindingId ?? "unknown"} on canvas "${canvasName}"`,
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
  if (!caller.ok) {
    return {
      ok: false,
      denial: "caller_wrong_kind",
      message: "matched node is not an actor — only actors are browser callers",
    };
  }

  const pageRefs = connectedPageRefs(doc, canvasName, node.id, viewOptions);
  if (pageRefs.length === 0) {
    return {
      ok: false,
      denial: "not_connected",
      message: "missing edge between caller and a page node — draw an edge in Vellum Command",
    };
  }

  // Drop any page ref whose node is no longer a page (paranoia).
  const live = pageRefs.filter((ref) => {
    const parsed = parseNodeRef(ref);
    return parsed.ok && isPageNode(findNode(doc, parsed.value.nodeId));
  });

  return {
    ok: true,
    principal: caller.principal,
    pageRefs: live.length > 0 ? live : pageRefs,
  };
};
