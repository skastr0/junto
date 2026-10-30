/**
 * The copy of a canvas one other machine holds (docs/machines.md, rule 2).
 *
 * The machine that edits a canvas keeps all of it. Every other machine with a
 * seat on it gets one snapshot, cut for that machine: its own seats and
 * terminals whole, every other seat as a peer it can address and never start,
 * every region as a rectangle, every resource as its place and its label, and
 * the private text only where it applies to that machine's seats. Bodies never
 * ride in the copy: it is one frame under the frame bound. This module is the
 * cut, and nothing else.
 *
 * A machine on the canvas's authority list is a keeper (0.11/06 F3): its copy
 * is the canvas as the editing machine holds it — every seat and terminal
 * whole, every region with every field, every note, every wire, every seat's
 * guidance and every reference — so it can take over and recut for anyone.
 * What never crosses is the same in both modes: no resolved secret value, no
 * credential, no session pin, no execution fact, no key material, and no
 * stub's path, address or host. `keeper` is named field by field, never by
 * spread.
 */
import { Schema, SchemaTransformation } from "effect";
import type { ActorSeatId } from "./actor-seat";
import { productNodeKindEnabled } from "./features";
import { InstallationId } from "./installation-id";
import {
  Artifacts,
  Automations,
  CanvasName,
  HostId,
  Label,
  NodeId,
  Note,
  Peer,
  Region,
  Seat,
  Seq,
  Stub,
  type StubOf,
  TaskBoard,
  Terminal,
  Wire,
  placement,
  regionStack,
  type Node,
} from "./model";
import type { ResourceKind } from "./region-reach";
import { ItemId } from "./work-ids";
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

/**
 * A seat or terminal on the wire still carries `onRemove`, which this build
 * no longer has: a machine on a build before 2026-10-19 requires it, as
 * "detach" or "kill-session", and refuses a whole copy without it. Sent as
 * "detach"; whatever an older machine sends is read and dropped. Retire it in
 * a release of its own, once no machine that links runs such a build.
 */
const OldOnRemove = Schema.optionalKey(Schema.Literals(["detach", "stop", "kill-session"]));

const CopiedSeatFields = Schema.Struct({ ...Seat.fields, onRemove: OldOnRemove });
const CopiedSeat = CopiedSeatFields.pipe(
  Schema.decodeTo(
    Seat,
    SchemaTransformation.transform({
      // The same fields on both sides; only `onRemove` differs.
      decode: ({ onRemove: _dropped, ...seat }) => seat as typeof Seat.Encoded,
      encode: (seat) => ({ ...seat, onRemove: "detach" }) as typeof CopiedSeatFields.Type,
    }),
  ),
);

const CopiedTerminalFields = Schema.Struct({ ...Terminal.fields, onRemove: OldOnRemove });
const CopiedTerminal = CopiedTerminalFields.pipe(
  Schema.decodeTo(
    Terminal,
    SchemaTransformation.transform({
      // The same fields on both sides; only `onRemove` differs.
      decode: ({ onRemove: _dropped, ...terminal }) => terminal as typeof Terminal.Encoded,
      encode: (terminal) => ({ ...terminal, onRemove: "detach" }) as typeof CopiedTerminalFields.Type,
    }),
  ),
);

/** Where a node sits, and nothing else: its colour stays where it was chosen. */
const { color: _color, ...geometry } = placement;

/**
 * A resource as every machine holds it: its kind, its place and its label.
 * The fields are listed, never spread, so a field added to a kind stays home
 * until it is named here. A task board's contract is body and stays home.
 */
const CopiedTask = Schema.Struct({ kind: TaskBoard.fields.kind, ...geometry, name: TaskBoard.fields.name });
const CopiedArtifacts = Schema.Struct({ kind: Artifacts.fields.kind, ...geometry, label: Artifacts.fields.label });
/** Bare text on the map: the text is its label. */
const CopiedLabel = Schema.Struct({ kind: Label.fields.kind, ...geometry, text: Label.fields.text });
/** The Automations node, so every machine places the automations on it; its automations ride rulings. */
const CopiedAutomations = Schema.Struct({ kind: Automations.fields.kind, ...geometry, label: Automations.fields.label });

const CopiedResource = Schema.Union([CopiedTask, CopiedArtifacts, CopiedLabel, CopiedAutomations, Stub]);
export type CopiedResource = typeof CopiedResource.Type;


/** One automation's place: its node, its id and the machine that runs it. */
const CopiedAutomation = Schema.Struct({ automationId: ItemId, nodeId: NodeId, machine: HostId });
export type CopiedAutomation = typeof CopiedAutomation.Type;

export const CanvasCopy = Schema.Struct({
  canvasName: CanvasName,
  canvasId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  /** The editing machine's count for this canvas. A copy replaces an older one. */
  seq: Seq,
  editor: InstallationId,
  /** The machine this copy was cut for. A copy cut for another machine is not this machine's. */
  target: InstallationId,
  seats: Schema.Array(CopiedSeat),
  peers: Schema.Array(Peer),
  terminals: Schema.Array(CopiedTerminal),
  regions: Schema.Array(Region),
  resources: Schema.Array(CopiedResource),
  wires: Schema.Array(Wire),
  guidance: Schema.Array(CopiedGuidance),
  briefing: Schema.optionalKey(Schema.String),
  references: Schema.Array(CopiedReference),
  playing: Schema.Boolean,
  /**
   * Where every automation runs at this count, by Automations node and id:
   * the editing machine judges an automation's rows by it as by a seat's.
   * Absent in a copy from before 0.11.
   */
  automations: Schema.optionalKey(Schema.Array(CopiedAutomation)),
  /**
   * A keeper's notes, whole (0.11/06 F3). Only a copy for a machine the
   * committed authority list names carries them; every other copy leaves
   * notes on the editing machine.
   */
  notes: Schema.optionalKey(Schema.Array(Note)),
});
export type CanvasCopy = typeof CanvasCopy.Type;

export const decodeCanvasCopy = Schema.decodeUnknownResult(CanvasCopy, { onExcessProperty: "error" });

/** A canvas as the machine that edits it holds it. */
export type CanvasCopySource = {
  readonly canvasName: CanvasName;
  readonly canvasId: string;
  readonly seq: number;
  readonly editor: InstallationId;
  /** The editing machine's real short name: where its pages live. */
  readonly editorMachineName: HostId;
  readonly nodes: ReadonlyArray<Node>;
  readonly wires: ReadonlyArray<Wire>;
  /** Soul and instructions by seat node id. */
  readonly guidance: Readonly<Record<string, SeatGuidance>>;
  readonly briefing: string | undefined;
  /** References of the whole app, and of this canvas's regions. */
  readonly references: ReadonlyArray<CopiedReference>;
  readonly playing: boolean;
  readonly seatIdOf: (seat: Seat) => ActorSeatId;
  /** Every live automation and the machine it runs on, the editing machine's for one that names none. */
  readonly automations: ReadonlyArray<CopiedAutomation>;
};

/**
 * Who a copy is cut for (0.11/06 F3): `"cut"` is the snapshot of today for a
 * machine that holds part of the canvas; `"keeper"` is the whole canvas for a
 * machine the committed authority list names.
 */
export type CanvasCopyMode = "cut" | "keeper";

export type CanvasCopyTarget = {
  readonly installationId: InstallationId;
  /** The machine's real short name, as seats name it. */
  readonly machineName: string;
};

export type CanvasCopyRefusal =
  | { readonly reason: "the-editing-machine-holds-the-canvas" }
  | { readonly reason: "a-row-names-no-machine"; readonly nodeId: string }
  | { readonly reason: "no-seat-or-automation-on-that-machine" }
  /** The copy is one frame and a link frame is bounded; over it the copy is refused, never truncated. */
  | { readonly reason: "over-the-frame-bound"; readonly bytes: number };

/**
 * The byte bound one copy frame must fit, the link's `frameBytes` limit
 * (0.11/06 F3): a keeper copy carries the whole canvas — every note, every
 * seat's guidance — and a canvas too large for one frame is refused loudly,
 * never sent cut down.
 */
export const CANVAS_COPY_FRAME_BUDGET = 1024 * 1024;

export type CanvasCopyResult =
  | { readonly ok: true; readonly copy: CanvasCopy }
  | { readonly ok: false; readonly refusal: CanvasCopyRefusal };

const namesNoMachine = (node: Node): boolean => {
  if (node.kind === "agent" || node.kind === "terminal" || node.kind === "files") return node.host === UNNAMED_MACHINE;
  if (node.kind !== "region") return false;
  return (
    Object.keys(node.defaults?.paths ?? {}).includes(UNNAMED_MACHINE) ||
    (node.environment?.sources ?? []).some((source) => source.host === UNNAMED_MACHINE)
  );
};

const placed = (node: Node) => ({
  id: node.id,
  x: node.x,
  y: node.y,
  width: node.width,
  height: node.height,
  z: node.z,
});

/** The kinds that cross: every kind a seat reaches, the cards beside them, and where automations sit. */
type CrossingKind = ResourceKind | "label" | "automations" | StubOf;

/** Takes only a kind that does not cross, so a crossing kind with no case fails to compile. */
const staysHome = (_kind: Exclude<Node["kind"], CrossingKind>): undefined => undefined;

/**
 * What every other machine holds of a node that is not a seat, a terminal or
 * a region. A kind crosses only when it is named here: a new kind stays home
 * until it is decided, and a crossing kind left unnamed does not compile.
 * Absent for a note, for what fires on its own host, for the kinds 0.10
 * deletes, and for a kind this build has switched off.
 */
const resourceOf = (node: Node, editorMachineName: HostId): CopiedResource | undefined => {
  if (!productNodeKindEnabled(node.kind)) return undefined;
  switch (node.kind) {
    case "task":
      return { kind: "task", ...placed(node), ...(node.name === undefined ? {} : { name: node.name }) };
    case "artifacts":
      return { kind: "artifacts", ...placed(node), ...(node.label === undefined ? {} : { label: node.label }) };
    case "label":
      return { kind: "label", ...placed(node), text: node.text };
    case "automations":
      return { kind: "automations", ...placed(node), ...(node.label === undefined ? {} : { label: node.label }) };
    // A stub is called by what the operator wrote, never by its path or address:
    // a Files node crosses with no host, root, folder name or file count.
    case "file":
    case "link":
    case "git":
    case "files":
      return { kind: "stub", of: node.kind, ...placed(node), ...(node.label === undefined ? {} : { label: node.label }) };
    // A page's name stays home with it: a page stub names only its machine.
    case "page":
      return { kind: "stub", of: "page", ...placed(node), host: editorMachineName };
    default:
      return staysHome(node.kind);
  }
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
 * machine and for the editing machine itself. A `"cut"` copy goes only to a
 * machine with a seat or an automation on the canvas; a `"keeper"` copy is
 * the canvas whole, for a machine the committed authority list names, and a
 * seatless one is still owed it.
 */
export const exportCanvasCopy = (
  source: CanvasCopySource,
  target: CanvasCopyTarget,
  mode: CanvasCopyMode,
): CanvasCopyResult => {
  if (target.installationId === source.editor) {
    return { ok: false, refusal: { reason: "the-editing-machine-holds-the-canvas" } };
  }
  const unnamed = source.nodes.find(namesNoMachine);
  if (unnamed !== undefined) {
    return { ok: false, refusal: { reason: "a-row-names-no-machine", nodeId: unnamed.id } };
  }
  const keeper = mode === "keeper";
  const seats: Seat[] = [];
  const peers: Peer[] = [];
  const terminals: Terminal[] = [];
  const regions: Region[] = [];
  const notes: Note[] = [];
  const resources: CopiedResource[] = [];
  for (const node of source.nodes) {
    const resource = resourceOf(node, source.editorMachineName);
    if (resource !== undefined) resources.push(resource);
    if (node.kind === "agent") {
      if (keeper || node.host === target.machineName) {
        seats.push(node);
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
      if (keeper || node.host === target.machineName) terminals.push(node);
    } else if (node.kind === "region") {
      regions.push(node);
    } else if (keeper && node.kind === "note") {
      notes.push(node);
    }
  }
  // A machine with automations and no seat holds the canvas too: it runs them.
  // A keeper keeps the canvas whole whether a seat or an automation is on it.
  if (!keeper && seats.length === 0 && !source.automations.some((automation) => automation.machine === target.machineName)) {
    return { ok: false, refusal: { reason: "no-seat-or-automation-on-that-machine" } };
  }

  const placed = { nodes: new Map(source.nodes.map((node) => [node.id, node])) };
  const mine = new Set<string>();
  for (const seat of seats) {
    for (const region of regionStack(placed, seat.id)) mine.add(region.id);
  }
  // No wire to a stub: the receiving machine keeps no stub to end it on, and
  // a wire to a page would be something to drive it with.
  const wired = resources.filter((resource) => resource.kind !== "stub");
  const held = new Set<string>([...seats, ...peers, ...terminals, ...regions, ...wired].map((node) => node.id));
  const copy: CanvasCopy = {
    canvasName: source.canvasName,
    canvasId: source.canvasId,
    seq: source.seq,
    editor: source.editor,
    target: target.installationId,
    seats,
    peers,
    terminals,
    regions: keeper
      ? regions
      : regions.map((region) =>
          mine.has(region.id) ? forMachine(region, target.machineName) : outline(region),
        ),
    resources,
    wires: keeper ? [...source.wires] : source.wires.filter((wire) => held.has(wire.from) && held.has(wire.to)),
    guidance: seats.flatMap((seat) => {
      const guidance = source.guidance[seat.id];
      return guidance === undefined ? [] : [{ nodeId: seat.id, ...guidance }];
    }),
    ...(source.briefing === undefined ? {} : { briefing: source.briefing }),
    references: keeper
      ? [...source.references]
      : source.references.filter(
          (reference) => reference.regionId === undefined || mine.has(reference.regionId),
        ),
    playing: source.playing,
    automations: source.automations,
    ...(keeper ? { notes } : {}),
  };
  const bytes = new TextEncoder().encode(JSON.stringify({ kind: "copy", copy })).byteLength;
  if (bytes > CANVAS_COPY_FRAME_BUDGET) {
    return { ok: false, refusal: { reason: "over-the-frame-bound", bytes } };
  }
  return { ok: true, copy };
};
