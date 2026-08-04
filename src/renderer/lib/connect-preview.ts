import type { CanvasNode } from "@shared/canvas";
import {
  ALL_PORTS,
  grantLawForRoles,
  offersOf,
  roleOf,
  selectGrant,
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

const GRANTLESS_LABEL = "connects, allows nothing yet";

/**
 * Live would-be-grant preview for a candidate edge, before it is drawn.
 * Derived strictly from `grantLawForRoles` + no-mask `selectGrant` + target
 * `offersOf` — the same inputs `admit` uses for a fresh unported edge.
 * Actor↔actor therefore previews the target actor's mailbox ports by default.
 */
export const describeConnectPreview = (
  fromNode: CanvasNode | undefined,
  toNode: CanvasNode | undefined,
): ConnectPreview => {
  const fromRole = roleOf(specOf(fromNode));
  const toSpec = specOf(toNode);
  const toRole = roleOf(toSpec);
  const grant = selectGrant(grantLawForRoles(fromRole, toRole), undefined);
  const offers = offersOf(toSpec);
  const ports = ALL_PORTS.filter((port) => grant.allows(port, offers));
  return {
    fromRole,
    toRole,
    ports,
    label: ports.length > 0 ? `allows ${ports.length} action${ports.length === 1 ? "" : "s"}` : GRANTLESS_LABEL,
  };
};
