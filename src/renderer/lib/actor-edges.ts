/**
 * Read-only inventory of the wires on a seat — used on agent focus surfaces
 * so the operator sees connected peers and whether a board wakes the seat,
 * without inventing obsolete edge natures (soft / authorial stops).
 *
 * Live stoppage on a work lane is kernel-derived (actor blocked by task
 * attention) — never an authorable edge mode.
 */
import { asNodeId, type Canvas } from "@shared/model";
import { titleOf } from "@shared/model/title";
import { kindWord } from "./model-kind";

export type ActorEdgeRow = {
  readonly edgeId: string;
  readonly peerId: string;
  readonly peerTitle: string;
  /** The peer's kind in the words the rail prints, or "missing" for an end that is gone. */
  readonly peerKind: string;
  /** The seat is the wire's from end → out; its to end → in. */
  readonly direction: "out" | "in";
  /**
   * Live kernel phase only. `blocks` = seat is stopped on this wire right
   * now (derived). Absent = no stoppage paint — not "soft relationship".
   */
  readonly livePhase: "blocks" | "relates" | null;
};

/**
 * The wires on a seat, one row each, sorted by the peer's title then the wire
 * id. Empty for a node that is not a seat: a seat is the only actor the model
 * holds. `phaseByWireId` is the kernel's live overlay (blocks | relates).
 */
export const actorEdgeRows = (
  canvas: Canvas,
  actorNodeId: string,
  phaseByWireId?: ReadonlyMap<string, "blocks" | "relates"> | null,
): ReadonlyArray<ActorEdgeRow> => {
  if (canvas.nodes.get(asNodeId(actorNodeId))?.kind !== "agent") return [];

  const rows: ActorEdgeRow[] = [];
  for (const wire of canvas.wires.values()) {
    const out = wire.from === actorNodeId;
    const inn = wire.to === actorNodeId;
    if (!out && !inn) continue;

    const peerId = out ? wire.to : wire.from;
    const peer = canvas.nodes.get(peerId);
    rows.push({
      edgeId: wire.id,
      peerId,
      peerTitle: peer ? titleOf(peer) : peerId,
      peerKind: peer ? kindWord(peer.kind) : "missing",
      direction: out ? "out" : "in",
      livePhase: phaseByWireId?.get(wire.id) ?? null,
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
