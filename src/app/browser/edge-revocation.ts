/**
 * Edge-delete session teardown (canvas physics I10 / I20).
 *
 * Pure helpers + receipt types. Live teardown is driven from edge-grant
 * invalidateCanvas on the same model-change event.
 *
 * Law: teardown is keyed by (caller, target) pair — never by caller alone.
 * Honesty: a teardown the session plane did not perform never gets a success receipt.
 */

import type { Canvas } from "@shared/model";
import type { NodeRefKey } from "@shared/node-ref";
import { parseNodeRef } from "@shared/node-ref";
import {
  connectedPageRefs,
  findNode,
  isBrowserCallerNode,
  isPageNode,
} from "./authz";

export type EdgeRevocationStatus = "confirmed" | "not_confirmed";

/** Per-runtime revocation receipt — never invent success the session plane did not report. */
export type EdgeRevocationReceipt = {
  readonly canvasName: string;
  readonly pageRef: NodeRefKey;
  readonly callerNodeId: string;
  readonly status: EdgeRevocationStatus;
  readonly detail: string;
};

export type LostPageTarget = {
  readonly pageRef: NodeRefKey;
  readonly pageNodeId: string;
  readonly callerNodeId: string;
};

/**
 * Page refs that were edge-reachable under previous but not under next for
 * the given caller node. Undirected edges; page kind only.
 */
export const lostPageTargetsForCaller = (
  _previous: Canvas | undefined,
  next: Canvas | undefined,
  canvasName: string,
  callerNodeId: string,
  previousTargets: ReadonlyArray<{ readonly ref: string }>,
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
      pageNodeId: parsed.value.nodeId,
      callerNodeId,
    });
  }
  return lost;
};

/**
 * When next is gone (canvas remove), every previous target is lost.
 */
export const allTargetsLost = (
  previousTargets: ReadonlyArray<{ readonly ref: string }>,
  _canvasName: string,
  callerNodeId: string,
): ReadonlyArray<LostPageTarget> =>
  previousTargets.flatMap((target) => {
    const parsed = parseNodeRef(target.ref);
    if (!parsed.ok) return [];
    return [
      {
        pageRef: target.ref as NodeRefKey,
        pageNodeId: parsed.value.nodeId,
        callerNodeId,
      },
    ];
  });

/**
 * I20 honesty: every page is on this machine, so teardown is confirmed only
 * when the local session plane ran it. A missing or failed plane is
 * not_confirmed.
 */
export const receiptForTeardown = (input: {
  readonly canvasName: string;
  readonly pageRef: NodeRefKey;
  readonly callerNodeId: string;
  /** Sessions destroyed, or `undefined` when the session plane did not run. */
  readonly sessionsDestroyed: number | undefined;
}): EdgeRevocationReceipt => {
  const { canvasName, pageRef, callerNodeId, sessionsDestroyed } = input;
  if (sessionsDestroyed === undefined) {
    return {
      canvasName,
      pageRef,
      callerNodeId,
      status: "not_confirmed",
      detail: "session teardown not confirmed",
    };
  }
  return {
    canvasName,
    pageRef,
    callerNodeId,
    status: "confirmed",
    detail:
      sessionsDestroyed > 0
        ? `revoked ${sessionsDestroyed} session(s)`
        : "capability revoked",
  };
};

/** True when a node id is still a page on the canvas. */
export const stillPageNode = (doc: Canvas | undefined, nodeId: string): boolean =>
  doc !== undefined && isPageNode(findNode(doc, nodeId));

