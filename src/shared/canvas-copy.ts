/**
 * The copy of a canvas one other machine holds (docs/machines.md, rule 2).
 *
 * The machine that edits a canvas keeps all of it. Every other machine with a
 * seat on it gets one snapshot, cut for that machine: its own seats and
 * terminals whole, every other seat as a peer it can address and never start,
 * every region as a rectangle, and the private text only where it applies to
 * that machine's seats. This module is the cut, and nothing else.
 */
import { Schema } from "effect";
import type { ActorSeatId } from "./actor-seat";
import { InstallationId } from "./installation-id";
import {
  CanvasName,
  NodeId,
  Peer,
  Region,
  Seat,
  Seq,
  Terminal,
  Wire,
  regionStack,
  type Node,
} from "./model";
import type { HostId } from "./remote-hosts";
import type { SeatGuidance } from "./seat-guidance";

/** The word a row may not use for a machine: it would mean a different one on every copy. */
export const UNNAMED_MACHINE = "local";

const CopiedGuidance = Schema.Struct({
  nodeId: NodeId,
  soul: Schema.optionalKey(Schema.String),
  instructions: Schema.optionalKey(Schema.String),
});

const CopiedReference = Schema.Struct({
  /** The region it belongs to; absent for a reference of the whole app. */
  regionId: Schema.optionalKey(NodeId),
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  body: Schema.String,
});
export type CopiedReference = typeof CopiedReference.Type;

export const CanvasCopy = Schema.Struct({
  canvasName: CanvasName,
  canvasId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  /** The editing machine's count for this canvas. A copy replaces an older one. */
  seq: Seq,
  editor: InstallationId,
  /** The machine this copy was cut for. A copy cut for another machine is not this machine's. */
  target: InstallationId,
  seats: Schema.Array(Seat),
  peers: Schema.Array(Peer),
  terminals: Schema.Array(Terminal),
  regions: Schema.Array(Region),
  wires: Schema.Array(Wire),
  guidance: Schema.Array(CopiedGuidance),
  briefing: Schema.optionalKey(Schema.String),
  references: Schema.Array(CopiedReference),
  playing: Schema.Boolean,
});
export type CanvasCopy = typeof CanvasCopy.Type;

export const decodeCanvasCopy = Schema.decodeUnknownResult(CanvasCopy, { onExcessProperty: "error" });

/** A canvas as the machine that edits it holds it. */
export type CanvasCopySource = {
  readonly canvasName: CanvasName;
  readonly canvasId: string;
  readonly seq: number;
  readonly editor: InstallationId;
  readonly nodes: ReadonlyArray<Node>;
  readonly wires: ReadonlyArray<Wire>;
  /** Soul and instructions by seat node id. */
  readonly guidance: Readonly<Record<string, SeatGuidance>>;
  readonly briefing: string | undefined;
  /** References of the whole app, and of this canvas's regions. */
  readonly references: ReadonlyArray<CopiedReference>;
  readonly playing: boolean;
  readonly seatIdOf: (seat: Seat) => ActorSeatId;
};

export type CanvasCopyTarget = {
  readonly installationId: InstallationId;
  /** The machine's real short name, as seats name it. */
  readonly machineName: string;
};

export type CanvasCopyRefusal =
  | { readonly reason: "the-editing-machine-holds-the-canvas" }
  | { readonly reason: "a-row-names-no-machine"; readonly nodeId: string }
  | { readonly reason: "no-seat-on-that-machine" };

export type CanvasCopyResult =
  | { readonly ok: true; readonly copy: CanvasCopy }
  | { readonly ok: false; readonly refusal: CanvasCopyRefusal };

const namesNoMachine = (node: Node): boolean => {
  if (node.kind === "agent" || node.kind === "terminal" || node.kind === "page") {
    return node.host === UNNAMED_MACHINE;
  }
  if (node.kind !== "region") return false;
  return (
    Object.keys(node.defaults?.paths ?? {}).includes(UNNAMED_MACHINE) ||
    node.defaults?.page?.host === UNNAMED_MACHINE ||
    (node.environment?.sources ?? []).some((source) => source.host === UNNAMED_MACHINE)
  );
};

/** A region as a rectangle: what every machine needs to resolve what is inside it. */
const outline = (region: Region): Region => ({
  kind: "region",
  id: region.id,
  x: region.x,
  y: region.y,
  width: region.width,
  height: region.height,
  z: region.z,
  ...(region.label === undefined ? {} : { label: region.label }),
  hold: region.hold,
});

/** A region with what applies to seats on one machine inside it. */
const forMachine = (region: Region, machineName: string): Region => {
  const folder = region.defaults?.paths?.[machineName as HostId];
  const sources = region.environment?.sources?.filter(
    (source) => source.host === undefined || source.host === machineName,
  );
  const environment =
    region.environment === undefined
      ? undefined
      : {
          ...(region.environment.sealed === undefined ? {} : { sealed: region.environment.sealed }),
          ...(sources === undefined ? {} : { sources }),
          ...(region.environment.folders === undefined ? {} : { folders: region.environment.folders }),
        };
  return {
    ...outline(region),
    ...(region.instruction === undefined ? {} : { instruction: region.instruction }),
    ...(folder === undefined ? {} : { defaults: { paths: { [machineName]: folder } } }),
    ...(region.contract === undefined ? {} : { contract: region.contract }),
    ...(environment === undefined ? {} : { environment }),
  };
};

/**
 * Cut one canvas for one machine. Refuses while any row still names no real
 * machine, for the editing machine itself, and for a machine with no seat on
 * the canvas.
 */
export const exportCanvasCopy = (
  source: CanvasCopySource,
  target: CanvasCopyTarget,
): CanvasCopyResult => {
  if (target.installationId === source.editor) {
    return { ok: false, refusal: { reason: "the-editing-machine-holds-the-canvas" } };
  }
  const unnamed = source.nodes.find(namesNoMachine);
  if (unnamed !== undefined) {
    return { ok: false, refusal: { reason: "a-row-names-no-machine", nodeId: unnamed.id } };
  }
  const seats: Seat[] = [];
  const peers: Peer[] = [];
  const terminals: Terminal[] = [];
  const regions: Region[] = [];
  for (const node of source.nodes) {
    if (node.kind === "agent") {
      if (node.host === target.machineName) {
        // The session a seat runs is its machine's own record, never the editing machine's.
        const { sessionId: _session, ...seat } = node;
        seats.push(seat);
      } else {
        peers.push({
          kind: "peer",
          id: node.id,
          x: node.x,
          y: node.y,
          width: node.width,
          height: node.height,
          z: node.z,
          label: node.label,
          host: node.host,
          seatId: source.seatIdOf(node),
        });
      }
    } else if (node.kind === "terminal") {
      if (node.host === target.machineName) terminals.push(node);
    } else if (node.kind === "region") {
      regions.push(node);
    }
  }
  if (seats.length === 0) return { ok: false, refusal: { reason: "no-seat-on-that-machine" } };

  const placed = { nodes: new Map(source.nodes.map((node) => [node.id, node])) };
  const mine = new Set<string>();
  for (const seat of seats) {
    for (const region of regionStack(placed, seat.id)) mine.add(region.id);
  }
  const held = new Set<string>([...seats, ...peers, ...terminals, ...regions].map((node) => node.id));
  return {
    ok: true,
    copy: {
      canvasName: source.canvasName,
      canvasId: source.canvasId,
      seq: source.seq,
      editor: source.editor,
      target: target.installationId,
      seats,
      peers,
      terminals,
      regions: regions.map((region) =>
        mine.has(region.id) ? forMachine(region, target.machineName) : outline(region),
      ),
      wires: source.wires.filter((wire) => held.has(wire.from) && held.has(wire.to)),
      guidance: seats.flatMap((seat) => {
        const guidance = source.guidance[seat.id];
        return guidance === undefined ? [] : [{ nodeId: seat.id, ...guidance }];
      }),
      ...(source.briefing === undefined ? {} : { briefing: source.briefing }),
      references: source.references.filter(
        (reference) => reference.regionId === undefined || mine.has(reference.regionId),
      ),
      playing: source.playing,
    },
  };
};
