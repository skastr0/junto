import type { CanvasNode } from "@shared/canvas";
import {
  ALL_PORTS,
  defaultGrantForRoles,
  offersOf,
  roleOf,
  type FactoryRoleName,
  type PortName,
} from "@shared/physics";
import { specOf } from "./node-spec";

export type ConnectPreview = {
  readonly fromRole: FactoryRoleName;
  readonly toRole: FactoryRoleName;
  readonly ports: ReadonlyArray<PortName>;
  readonly label: string;
};

const GRANTLESS_LABEL = "reach + phase only — no ports offered";

/**
 * Live would-be-grant preview for a candidate edge, before it is drawn.
 * Derived strictly from `defaultGrantForRoles` + target `offersOf` — the same
 * inputs `admit` itself uses — never a hand-authored per-pair copy table.
 * A later law change (S2 mask union, S3 GrantLaw, S11 placement) changes what
 * this function computes; it never requires rework of the copy here.
 */
export const describeConnectPreview = (
  fromNode: CanvasNode | undefined,
  toNode: CanvasNode | undefined,
): ConnectPreview => {
  const fromRole = roleOf(specOf(fromNode));
  const toSpec = specOf(toNode);
  const toRole = roleOf(toSpec);
  const grant = defaultGrantForRoles(fromRole, toRole);
  const offers = offersOf(toSpec);
  const ports = ALL_PORTS.filter((port) => grant.allows(port, offers));
  return {
    fromRole,
    toRole,
    ports,
    label: ports.length > 0 ? `will grant: ${ports.join(", ")}` : GRANTLESS_LABEL,
  };
};
