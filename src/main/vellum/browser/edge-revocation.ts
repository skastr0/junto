/**
 * Edge-delete session teardown (factory physics I10 / I20).
 *
 * Pure helpers + receipt types. Live teardown is driven from edge-grant
 * invalidateCanvas on the same document-commit tick as canvas write/mutate.
 *
 * Law: teardown is keyed by (caller, target) pair — never by caller alone.
 * Honesty: an unreachable host never gets a success receipt Vellum Command cannot prove.
 */

import type { CanvasDoc } from "@shared/canvas";
import type { NodeRefKey } from "@shared/node-ref";
import { parseNodeRef } from "@shared/node-ref";
import {
  connectedPageRefs,
  findNode,
  isBrowserCallerNode,
  isPageNode,
} from "./authz";

export type EdgeRevocationStatus = "confirmed" | "not_confirmed";

/** Per-runtime revocation receipt — never invent success for an unreachable host. */
export type EdgeRevocationReceipt = {
  readonly canvasName: string;
  readonly pageRef: NodeRefKey;
  readonly hostId: string;
  readonly callerNodeId: string;
  readonly status: EdgeRevocationStatus;
  /** Human-readable; not_confirmed always names the host. */
  readonly detail: string;
};

export type LostPageTarget = {
  readonly pageRef: NodeRefKey;
  readonly pageNodeId: string;
  readonly callerNodeId: string;
  readonly hostId: string;
};

/**
 * Page refs that were edge-reachable under previous but not under next for
 * the given caller node. Undirected edges; page kind only.
 */
export const lostPageTargetsForCaller = (
  _previous: CanvasDoc | undefined,
  next: CanvasDoc | undefined,
  canvasName: string,
  callerNodeId: string,
  previousTargets: ReadonlyArray<{
    readonly ref: string;
    readonly hostId: string;
  }>,
): ReadonlyArray<LostPageTarget> => {
  const remaining = new Set<string>(
    next === undefined ? [] : connectedPageRefs(next, canvasName, callerNodeId),
  );

  const lost: LostPageTarget[] = [];
  for (const target of previousTargets) {
    if (remaining.has(target.ref)) continue;
    const parsed = parseNodeRef(target.ref);
    if (!parsed.ok) continue;
    lost.push({
      pageRef: target.ref as NodeRefKey,
      pageNodeId: parsed.success.nodeId,
      callerNodeId,
      hostId: target.hostId,
    });
  }
  return lost;
};

/**
 * When next is gone (canvas remove), every previous target is lost.
 */
export const allTargetsLost = (
  previousTargets: ReadonlyArray<{
    readonly ref: string;
    readonly hostId: string;
  }>,
  _canvasName: string,
  callerNodeId: string,
): ReadonlyArray<LostPageTarget> =>
  previousTargets.flatMap((target) => {
    const parsed = parseNodeRef(target.ref);
    if (!parsed.ok) return [];
    return [
      {
        pageRef: target.ref as NodeRefKey,
        pageNodeId: parsed.success.nodeId,
        callerNodeId,
        hostId: target.hostId,
      },
    ];
  });

/**
 * I20 honesty: only confirm teardown we can prove on a reachable host that
 * matches this station (local session plane). Anything else is not_confirmed.
 */
export const receiptForHostTeardown = (input: {
  readonly canvasName: string;
  readonly pageRef: NodeRefKey;
  readonly hostId: string;
  readonly callerNodeId: string;
  readonly localHostId: string | undefined;
  readonly hostReachable: boolean;
  readonly sessionsDestroyed: number;
}): EdgeRevocationReceipt => {
  const onLocalHost =
    input.localHostId !== undefined && input.localHostId === input.hostId;
  if (onLocalHost && input.hostReachable) {
    return {
      canvasName: input.canvasName,
      pageRef: input.pageRef,
      hostId: input.hostId,
      callerNodeId: input.callerNodeId,
      status: "confirmed",
      detail:
        input.sessionsDestroyed > 0
          ? `revoked ${input.sessionsDestroyed} session(s) on host ${input.hostId}`
          : `capability revoked on host ${input.hostId}`,
    };
  }
  return {
    canvasName: input.canvasName,
    pageRef: input.pageRef,
    hostId: input.hostId,
    callerNodeId: input.callerNodeId,
    status: "not_confirmed",
    detail: `not confirmed on host ${input.hostId}`,
  };
};

/** True when a node id is still a page on the document. */
export const stillPageNode = (doc: CanvasDoc | undefined, nodeId: string): boolean =>
  doc !== undefined && isPageNode(findNode(doc, nodeId));

/**
 * True when a node id is still an actor seat (the caller side of a grant).
 * Asks the one caller predicate, exactly as {@link stillPageNode} asks the one
 * page predicate — the actor kinds are not re-listed here.
 */
export const stillCallerNode = (doc: CanvasDoc | undefined, nodeId: string): boolean =>
  doc !== undefined && isBrowserCallerNode(findNode(doc, nodeId));
