/**
 * Read-only inventory of edges incident to an actor node — used on agent
 * focus surfaces so the operator sees connected peers, ports, and wake
 * without inventing obsolete edge natures (soft / authorial stops).
 *
 * Live stoppage on a work lane is kernel-derived (actor blocked by task
 * attention) — never an authorable edge mode.
 */
import {
  compileEdgeGrant,
  edgeKindIndex,
  type CanvasDoc,
  type CanvasNode,
} from "@shared/canvas";
import { isGroup } from "@shared/graph";
import {
  resolveSpec,
  roleOf,
  type PortName,
  type VerbGrant,
} from "@shared/physics";
import { nodeTitle } from "./presentation";

export type ActorEdgeRow = {
  readonly edgeId: string;
  readonly peerId: string;
  readonly peerTitle: string;
  readonly peerKind: string;
  /** Actor is fromNode → out; actor is toNode → in. */
  readonly direction: "out" | "in";
  /** Ports the relationship's verb opens toward the peer (reach). */
  readonly ports: ReadonlyArray<PortName>;
  /** Board megaphone: `participates` = ON, the quiet board verb = OFF. */
  readonly boardNotify: "on" | "off" | null;
  /**
   * Live kernel phase only. `blocks` = seat is stopped on this wire right
   * now (derived). Absent = no stoppage paint — not "soft relationship".
   */
  readonly livePhase: "blocks" | "relates" | null;
};

const peerKindOf = (peer: CanvasNode | undefined): string => {
  if (!peer) return "missing";
  if (peer.ether?.entity?.kind) return peer.ether.entity.kind;
  if (isGroup(peer)) return "region";
  return peer.type;
};

const boardNotifyOf = (
  grant: VerbGrant | undefined,
  actor: CanvasNode,
  peer: CanvasNode | undefined,
): "on" | "off" | null => {
  const touchesBoard =
    actor.ether?.entity?.kind === "board" ||
    peer?.ether?.entity?.kind === "board";
  if (!touchesBoard) return null;
  // `participates` wakes the seat; the quiet board verb (`messages`) does not.
  return grant?.wake === true ? "on" : "off";
};

/**
 * Directed incident edges for an actor seat, sorted peer title then edge id.
 * `phaseByEdgeId` is optional live kernel overlay (blocks | relates).
 */
export const actorEdgeRows = (
  doc: CanvasDoc,
  actorNodeId: string,
  phaseByEdgeId?: ReadonlyMap<string, "blocks" | "relates"> | null,
): ReadonlyArray<ActorEdgeRow> => {
  const actor = doc.nodes.find((n) => n.id === actorNodeId);
  if (!actor) return [];
  const actorRole = roleOf(
    resolveSpec({ isGroup: isGroup(actor), kind: actor.ether?.entity?.kind }),
  );
  if (actorRole !== "actor") return [];

  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const kinds = edgeKindIndex(doc);
  const rows: ActorEdgeRow[] = [];

  for (const edge of doc.edges) {
    const out = edge.fromNode === actorNodeId;
    const inn = edge.toNode === actorNodeId;
    if (!out && !inn) continue;

    const peerId = out ? edge.toNode : edge.fromNode;
    const peer = byId.get(peerId);
    const grant = compileEdgeGrant(edge, kinds);
    const phase = phaseByEdgeId?.get(edge.id) ?? null;

    rows.push({
      edgeId: edge.id,
      peerId,
      peerTitle: peer ? nodeTitle(peer) : peerId,
      peerKind: peerKindOf(peer),
      direction: out ? "out" : "in",
      ports: grant?.ports ?? [],
      boardNotify: boardNotifyOf(grant, actor, peer),
      livePhase: phase,
    });
  }

  rows.sort((a, b) => {
    const t = a.peerTitle.localeCompare(b.peerTitle);
    return t !== 0 ? t : a.edgeId.localeCompare(b.edgeId);
  });
  return rows;
};

/** Live stoppage label only — never "soft". */
export const actorEdgePhaseLabel = (
  row: ActorEdgeRow,
): "blocks" | null => (row.livePhase === "blocks" ? "blocks" : null);
