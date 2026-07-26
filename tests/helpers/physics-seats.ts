/**
 * Board / phase-graph fixtures in **physics vocabulary**.
 * Kind strings are registry plumbing only — never name seats as agent/herdr/…
 * in product or board-rule tests. ACP-specific tests may use kind directly.
 */
import type { CanvasNode, TextNode } from "../../src/shared/canvas";
import {
  kindsWithRole,
  seatMayBeBlocked,
  type FactoryRoleName,
  type WellKnownKindName,
} from "../../src/shared/physics";

export const kindForRole = (role: FactoryRoleName): WellKnownKindName => {
  const kind = kindsWithRole(role)[0];
  if (kind === undefined) {
    throw new Error(`KindSpecs has no well-known kind for role "${role}"`);
  }
  return kind;
};

/** Minimal text seat whose derived physics role is `role`. */
export const seat = (
  id: string,
  role: FactoryRoleName,
  options?: {
    readonly label?: string;
    /** Join key for glyph/wip criteria when role is sink (or other named seats). */
    readonly name?: string;
    readonly x?: number;
    readonly y?: number;
    readonly flags?: ReadonlyArray<"blocker" | "parked" | "attention">;
  },
): TextNode => {
  const kind = kindForRole(role);
  const name = options?.name ?? (role === "sink" ? id : undefined);
  return {
    id,
    type: "text",
    text: options?.label ?? id,
    x: options?.x ?? 0,
    y: options?.y ?? 0,
    width: 200,
    height: 80,
    ether: {
      entity: {
        kind,
        ...(name !== undefined ? { name } : {}),
      },
      ...(options?.flags ? { flags: [...options.flags] } : {}),
    },
  };
};

export const geographySeat = (id: string, label = id): TextNode => ({
  id,
  type: "text",
  text: label,
  x: 0,
  y: 0,
  width: 200,
  height: 80,
});

export const assertSeatRole = (node: CanvasNode, role: FactoryRoleName): void => {
  const mayBlock = seatMayBeBlocked({
    isGroup: node.type === "group",
    kind: node.ether?.entity?.kind,
  });
  if (role === "actor" && !mayBlock) {
    throw new Error(`expected actor seat ${node.id} to be phase-blockable`);
  }
  if (role !== "actor" && mayBlock) {
    throw new Error(`expected non-actor seat ${node.id} not to be phase-blockable`);
  }
};
