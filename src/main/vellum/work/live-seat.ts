/**
 * Live-canvas seat proof for route-token mint.
 * Pure: takes already-loaded live documents; never reads disk.
 */
import type { CanvasDoc } from "@shared/canvas";
import type { ProcessPrincipal } from "../process-identity";
import {
  resolveCallerAcrossCanvases,
  type CallerResolveResult,
} from "./caller-resolve";
import type { RouteTokenMintPrincipal } from "./route-tokens";

export type LiveSeatProof =
  | {
      readonly ok: true;
      readonly principal: RouteTokenMintPrincipal;
    }
  | {
      readonly ok: false;
      readonly code: "not_found" | "ambiguous" | "invalid";
      readonly message: string;
    };

const toProcessPrincipal = (
  p: RouteTokenMintPrincipal,
): ProcessPrincipal | { readonly error: string } => {
  if (p.kind === "terminal") {
    return {
      error:
        "route-token seats cannot be kind terminal (process-bind only)",
    };
  }
  if (p.kind === "agent") {
    if (!p.agentKey?.trim()) {
      return { error: "agent route-token requires agentKey" };
    }
    return {
      kind: "agent",
      canvasName: p.canvasName,
      nodeId: p.nodeId,
      agentKey: p.agentKey.trim(),
    };
  }
  // herdr
  if (!p.paneId?.trim() && !p.nodeId?.trim()) {
    return { error: "herdr route-token requires paneId or nodeId" };
  }
  return {
    kind: "herdr",
    canvasName: p.canvasName,
    nodeId: p.nodeId,
    ...(p.paneId?.trim() ? { paneId: p.paneId.trim() } : {}),
  };
};

/**
 * Prove mint principal against live in-process canvas authority.
 * Both canvasName and nodeId required; agentKey/paneId must match the live card.
 */
export const proveLiveSeat = (
  liveDocs: ReadonlyArray<{
    readonly canvasName: string;
    readonly doc: CanvasDoc;
  }>,
  candidate: RouteTokenMintPrincipal,
): LiveSeatProof => {
  const canvasName = candidate.canvasName?.trim() ?? "";
  const nodeId = candidate.nodeId?.trim() ?? "";
  if (canvasName.length === 0 || nodeId.length === 0) {
    return {
      ok: false,
      code: "invalid",
      message: "route-token mint requires canvasName and nodeId",
    };
  }
  if (candidate.kind === "terminal") {
    return {
      ok: false,
      code: "invalid",
      message: "route-token seats cannot be kind terminal",
    };
  }

  const principalOrErr = toProcessPrincipal({
    ...candidate,
    canvasName,
    nodeId,
  });
  if ("error" in principalOrErr) {
    return { ok: false, code: "invalid", message: principalOrErr.error };
  }

  const resolved: CallerResolveResult = resolveCallerAcrossCanvases(
    liveDocs,
    principalOrErr,
  );
  if (!resolved.ok) {
    return {
      ok: false,
      code: resolved.code,
      message: resolved.message,
    };
  }

  // Bound to the requested canvas/node exactly.
  if (
    resolved.caller.canvasName !== canvasName ||
    resolved.caller.nodeId !== nodeId
  ) {
    return {
      ok: false,
      code: "not_found",
      message: `live seat is ${resolved.caller.canvasName}:${resolved.caller.nodeId}, not ${canvasName}:${nodeId}`,
    };
  }

  return {
    ok: true,
    principal: Object.freeze({
      kind: candidate.kind,
      canvasName,
      nodeId,
      ...(candidate.kind === "agent" && candidate.agentKey?.trim()
        ? { agentKey: candidate.agentKey.trim() }
        : {}),
      ...(candidate.kind === "herdr" && candidate.paneId?.trim()
        ? { paneId: candidate.paneId.trim() }
        : {}),
    }),
  };
};
