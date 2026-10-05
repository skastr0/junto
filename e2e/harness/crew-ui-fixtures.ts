/**
 * Playwright selectors and canvas seeds for the crew mail surfaces.
 */
import type { CanvasEdge } from "../../src/shared/canvas";
import type { Port } from "../../src/shared/physics/schema";
import { verbEdge } from "./sandbox";

export const CREW_UI_SELECTORS = {
  mailRow: "actor-ledger-mail-row",
  ledger: "seat-details",
} as const;

/** `ether.mask` is the allow-list. Omitted grants the compile; empty grants none. */
export const messagesEdgeWithMask = (
  id: string,
  fromNode: string,
  toNode: string,
  kinds: Parameters<typeof verbEdge>[4],
  allowed: ReadonlyArray<Port> | undefined,
): CanvasEdge => {
  const edge = verbEdge(id, fromNode, toNode, "messages", kinds);
  return allowed === undefined
    ? edge
    : { ...edge, ether: { verb: "messages", mask: [...allowed] } };
};
