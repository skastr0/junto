import { asNodeId } from "./base";
import { regionName, regionStack, type Placed } from "./canvas";
import type { Node } from "./kinds";
import { titleOf } from "./title";

/**
 * Who a seat is, as another seat or an overseer reads it: its id, its name,
 * and every region around it, outermost first. One definition for onboard,
 * mail, the overseer and the notification line, so a seat is never known by
 * its id alone.
 */

/** One region around a seat: its id and the name it is called by. */
export type SeatRegion = { readonly id: string; readonly name: string };

export type SeatIdentity = {
  readonly nodeId: string;
  readonly name: string;
  /** Outermost first; empty when the seat is inside no region. */
  readonly regions: ReadonlyArray<SeatRegion>;
};

/** Every region around a node, outermost first, from the one membership rule. */
export const seatRegions = (canvas: Placed, nodeId: string): ReadonlyArray<SeatRegion> =>
  regionStack(canvas, asNodeId(nodeId)).map((region) => ({ id: region.id, name: regionName(region) }));

export const seatIdentity = (canvas: Placed, node: Node): SeatIdentity => ({
  nodeId: node.id,
  name: titleOf(node),
  regions: seatRegions(canvas, node.id),
});

/** The regions as one line, "Junto / CLI / mail"; undefined when there are none. */
export const regionPathText = (regions: ReadonlyArray<SeatRegion>): string | undefined =>
  regions.length === 0 ? undefined : regions.map((region) => region.name).join(" / ");

/** A seat as one line: "cli-lead (Junto / CLI)". */
export const seatLabel = (identity: Pick<SeatIdentity, "name" | "regions">): string => {
  const path = regionPathText(identity.regions);
  return path === undefined ? identity.name : `${identity.name} (${path})`;
};
