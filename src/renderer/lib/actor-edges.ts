/**
 * Read-only inventory of edges incident to an actor node — used on agent
 * focus surfaces so the operator sees connected sinks and edge nature
 * without opening the inspector.
 */
import { HashSet, Option, Schema } from "effect";
import type { CanvasDoc, CanvasEdge, CanvasNode } from "@shared/canvas";
import { isGroup } from "@shared/graph";
import {
  ALL_PORTS,
  Port,
  grantLawForRoles,
  offersOf,
  resolveSpec,
  roleOf,
  selectGrant,
  type PortName,
} from "@shared/physics";
import { nodeTitle } from "./presentation";
import { specOf } from "./node-spec";

const decodePort = Schema.decodeUnknownOption(Port);

export type ActorEdgeNature = "soft" | "tasks" | "proof" | "approval";

export type ActorEdgeRow = {
  readonly edgeId: string;
  readonly peerId: string;
  readonly peerTitle: string;
  readonly peerKind: string;
  /** Actor is fromNode → out; actor is toNode → in. */
  readonly direction: "out" | "in";
  readonly nature: ActorEdgeNature;
  /** Effective ports the actor can wield toward the peer (reach). */
  readonly ports: ReadonlyArray<PortName>;
  /** Board megaphone: absent/true = ON, explicit false = OFF. */
  readonly boardNotify: "on" | "off" | null;
  readonly livePhase: "blocks" | "relates" | null;
};

const natureOf = (edge: CanvasEdge): ActorEdgeNature => {
  const mode = edge.ether?.stops?.mode;
  if (mode === "tasks" || mode === "proof" || mode === "approval") return mode;
  return "soft";
};

const readMask = (edge: CanvasEdge): HashSet.HashSet<PortName> | undefined => {
  const ports = edge.ether?.ports;
  if (!ports || ports.length === 0) return undefined;
  let set = HashSet.empty<PortName>();
  let any = false;
  for (const p of ports) {
    const decoded = decodePort(p);
    if (Option.isSome(decoded)) {
      set = HashSet.add(set, decoded.value);
      any = true;
    }
  }
  return any ? set : undefined;
};

const effectivePorts = (
  caller: CanvasNode | undefined,
  target: CanvasNode | undefined,
  mask: HashSet.HashSet<PortName> | undefined,
): ReadonlyArray<PortName> => {
  const callerSpec = specOf(caller);
  const targetSpec = specOf(target);
  const law = grantLawForRoles(roleOf(callerSpec), roleOf(targetSpec));
  const grant = selectGrant(law, mask);
  if (grant.isEmpty()) return [];
  const offers = offersOf(targetSpec);
  return ALL_PORTS.filter((port) => grant.allows(port, offers));
};

const peerKindOf = (peer: CanvasNode | undefined): string => {
  if (!peer) return "missing";
  if (peer.ether?.entity?.kind) return peer.ether.entity.kind;
  if (isGroup(peer)) return "region";
  return peer.type;
};

const boardNotifyOf = (
  edge: CanvasEdge,
  actor: CanvasNode,
  peer: CanvasNode | undefined,
): "on" | "off" | null => {
  const touchesBoard =
    actor.ether?.entity?.kind === "board" ||
    peer?.ether?.entity?.kind === "board";
  if (!touchesBoard) return null;
  return edge.ether?.wake === false ? "off" : "on";
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
  const rows: ActorEdgeRow[] = [];

  for (const edge of doc.edges) {
    const out = edge.fromNode === actorNodeId;
    const inn = edge.toNode === actorNodeId;
    if (!out && !inn) continue;

    const peerId = out ? edge.toNode : edge.fromNode;
    const peer = byId.get(peerId);
    const mask = readMask(edge);
    // Reach is always actor → peer (what this seat can do on the connection).
    const ports = effectivePorts(actor, peer, mask);
    const phase = phaseByEdgeId?.get(edge.id) ?? null;

    rows.push({
      edgeId: edge.id,
      peerId,
      peerTitle: peer ? nodeTitle(peer) : peerId,
      peerKind: peerKindOf(peer),
      direction: out ? "out" : "in",
      nature: natureOf(edge),
      ports,
      boardNotify: boardNotifyOf(edge, actor, peer),
      livePhase: phase,
    });
  }

  rows.sort((a, b) => {
    const t = a.peerTitle.localeCompare(b.peerTitle);
    return t !== 0 ? t : a.edgeId.localeCompare(b.edgeId);
  });
  return rows;
};

/** Short human nature label for chips / a11y. */
export const actorEdgeNatureLabel = (row: ActorEdgeRow): string => {
  if (row.livePhase === "blocks") return "blocks";
  if (row.nature === "soft") return "soft";
  return row.nature;
};
