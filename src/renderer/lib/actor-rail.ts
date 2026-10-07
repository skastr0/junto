import { asNodeId, type Canvas, type Seat } from "@shared/model";
import { actorEdgeRows, type ActorEdgeRow } from "./actor-edges";
import { isMirrorablePeer } from "./actor-mirrors";
import { sectionOpen, setSectionOpen, type SectionOpenMap } from "./sidebar-sections";

/**
 * The agent modal's rail: the agents a seat is connected to, each drawn as
 * its canvas seat, then its other connections as plain rows. One rail, two
 * widths: expanded (seats with their name and line) and collapsed (a strip
 * of rings). A seat with no connections has no rail at all.
 */

export type ActorRailMode = "none" | "collapsed" | "expanded";

/** Whether the rail is expanded: one choice for every agent, kept with the other sidebar state. */
const RAIL_OPEN_KEY = "seat-rail";

export const actorRailExpanded = (map?: SectionOpenMap): boolean => sectionOpen(RAIL_OPEN_KEY, true, map);

export const setActorRailExpanded = (expanded: boolean): void => setSectionOpen(RAIL_OPEN_KEY, expanded);

export type ActorRailPeers = {
  /** Connected agents with a terminal to move to, one entry per agent. */
  readonly agents: ReadonlyArray<Seat>;
  /** Every other connection, one row per peer. */
  readonly others: ReadonlyArray<ActorEdgeRow>;
};

const NO_PEERS: ActorRailPeers = { agents: [], others: [] };

/** A seat's connections, split into agents and the rest; two wires to one peer are one entry. */
export const actorRailPeers = (canvas: Canvas, nodeId: string): ActorRailPeers => {
  // Only a seat has a rail; actorEdgeRows answers nothing for any other node.
  const rows = actorEdgeRows(canvas, nodeId, null);
  if (rows.length === 0) return NO_PEERS;
  const seen = new Set<string>();
  const agents: Seat[] = [];
  const others: ActorEdgeRow[] = [];
  for (const row of rows) {
    if (seen.has(row.peerId)) continue;
    seen.add(row.peerId);
    const peer = canvas.nodes.get(asNodeId(row.peerId));
    if (isMirrorablePeer(peer)) agents.push(peer);
    else others.push(row);
  }
  return { agents, others };
};

export const actorRailMode = (canvas: Canvas, nodeId: string, expanded: boolean): ActorRailMode => {
  const { agents, others } = actorRailPeers(canvas, nodeId);
  if (agents.length + others.length === 0) return "none";
  return expanded ? "expanded" : "collapsed";
};
