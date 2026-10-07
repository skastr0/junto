/**
 * Playwright selectors and canvas seeds for the crew mail surfaces.
 */
import type { Node, Wire } from "../../src/shared/model";
import type { Port } from "../../src/shared/physics/schema";
import { modelMessagesWire } from "./model";

export const CREW_UI_SELECTORS = {
  mailRow: "actor-ledger-mail-row",
  ledger: "seat-details",
} as const;

/** A mask keeps only the named permissions. Omitted grants the relationship; empty grants none. */
export const messagesWireWithMask = (
  id: string,
  from: string,
  to: string,
  nodes: ReadonlyArray<Node>,
  allowed: ReadonlyArray<Port> | undefined,
): Wire => modelMessagesWire(id, from, to, nodes, allowed);
