/**
 * Squads, pure: capture a squad from selected agent seats, and place one as
 * fresh seats. A squad is a set of agent profiles (see ./agent-profiles) plus
 * their layout and connections. No state, no IPC; callers supply the canvas,
 * the saved portraits and guidance, and where the squad lands.
 *
 * Capture
 * - Only agent seats with a managed harness go in, in paint order, each
 *   captured as a profile (name, character, harness dials, soul,
 *   instructions).
 * - Layout is kept relative to the selection's top-left corner.
 * - Connections go in only when both ends are captured seats.
 *
 * Place
 * - The squad is centered on the point. Inside a region it is moved to sit
 *   fully inside (so it joins the region); a squad larger than the region
 *   starts at the region's top-left corner.
 * - Every seat is minted from its profile by the ordinary seat factory: new
 *   node and binding ids. Main records the session when it starts.
 * - A seat works in its region's default folder for the host when it lands in
 *   one, else in the folder the placement names. When neither exists the
 *   placement asks for a folder instead of minting seats that cannot start.
 * - A seat whose harness this build does not know or ships disabled is
 *   skipped, and so is every connection touching it. A connection whose verb
 *   this build does not know is dropped; unknown sides fall away; a port mask
 *   only narrows, and one left with no known port drops its connection.
 */
import { asNodeId, asWireId, type Canvas, type Node, type NodeOf, type Wire } from "@shared/model";
import { topZ } from "./model-edits";
import { Schema } from "effect";
import { Side } from "@shared/model/base";
import { Verb } from "@shared/physics/verbs";
import { Port } from "@shared/physics/schema";
import type { PortraitOverride } from "@shared/portrait-overrides";
import type { SeatGuidance } from "@shared/seat-guidance";
import { findContainingRegion, resolveRegionCwd } from "@shared/region-defaults";
import {
  SQUAD_SEATS_MAX,
  type SquadBody,
  type SquadEdge,
  type SquadSeat,
} from "@shared/squads";
import {
  placeableHarness,
  profileBodyOfSeat,
  seatFromProfile,
  type ProfileCaptureSources,
} from "./agent-profiles";

/** Gap kept between a placed squad and its region's frame. */
export const SQUAD_REGION_PAD = 32;

const isVerb = Schema.is(Verb);
const isPort = Schema.is(Port);
const isSide = Schema.is(Side);

// --- capture -----------------------------------------------------------------

/** The agent seats a squad can be made from, in paint order. */
export const squadSeatNodes = (
  nodes: Iterable<Node>,
  selectedIds: ReadonlyArray<string>,
): NodeOf<"agent">[] => {
  const selected = new Set(selectedIds);
  return [...nodes].sort((a, b) => a.z - b.z).filter((node): node is NodeOf<"agent"> =>
    selected.has(node.id) && node.kind === "agent" && node.launch?.kind === "harness");
};

/** Capture a squad from the selection; null when it holds no agent seat. */
export const captureSquad = (
  canvas: Canvas,
  selectedIds: ReadonlyArray<string>,
  options: ProfileCaptureSources = {},
): SquadBody | null => {
  const captured = squadSeatNodes(canvas.nodes.values(), selectedIds)
    .slice(0, SQUAD_SEATS_MAX)
    .flatMap((node) => {
      const profile = profileBodyOfSeat(node, options);
      return profile ? [{ node, profile }] : [];
    });
  if (captured.length === 0) return null;
  const minX = Math.min(...captured.map(({ node }) => node.x));
  const minY = Math.min(...captured.map(({ node }) => node.y));
  const keyOf = new Map(captured.map(({ node }, index) => [node.id, `s${index}`] as const));

  const seats: SquadSeat[] = captured.map(({ node, profile }) => ({
    key: keyOf.get(node.id)!,
    profile,
    dx: Math.round(node.x - minX),
    dy: Math.round(node.y - minY),
    width: node.width,
    height: node.height,
    ...(node.color ? { color: node.color } : {}),
  }));

  const edges: SquadEdge[] = [...canvas.wires.values()].flatMap((edge) => {
    const from = keyOf.get(edge.from);
    const to = keyOf.get(edge.to);
    const verb = edge.verb;
    if (!from || !to || !verb) return [];
    return [{
      from,
      to,
      verb,
      ...(edge.mask ? { mask: [...edge.mask] } : {}),
      ...(edge.fromSide ? { fromSide: edge.fromSide } : {}),
      ...(edge.toSide ? { toSide: edge.toSide } : {}),
    }];
  });

  return { seats, edges };
};

// --- place -------------------------------------------------------------------

export type SquadIds = {
  readonly edgeId: () => string;
};

/** Where a squad lands: the host its seats run on and a fallback folder. */
export type SquadLaunch = {
  readonly host: string;
  readonly agentHost?: string;
  /** Folder for seats that land outside a region with a default folder. */
  readonly cwd?: string;
};

export type SquadPlacement = {
  readonly nodes: ReadonlyArray<NodeOf<"agent">>;
  readonly edges: ReadonlyArray<Wire>;
  /** Portrait override to save for each new seat, by new node id. */
  readonly portraits: Readonly<Record<string, PortraitOverride>>;
  /** Soul and instructions to save for each new seat, by new node id. */
  readonly guidance: Readonly<Record<string, SeatGuidance>>;
  /** Names of seats this build could not place. */
  readonly skipped: ReadonlyArray<string>;
  /** Region the squad landed in, if any. */
  readonly regionId?: string;
  /** No folder for at least one seat: nothing was placed; ask for one. */
  readonly needsFolder?: boolean;
};

type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

export const squadBounds = (squad: SquadBody): { readonly width: number; readonly height: number } => ({
  width: Math.max(...squad.seats.map((seat) => seat.dx + seat.width)),
  height: Math.max(...squad.seats.map((seat) => seat.dy + seat.height)),
});

/** Top-left corner for the squad: centered on the point, kept inside its region. */
export const squadOrigin = (
  size: { readonly width: number; readonly height: number },
  at: { readonly x: number; readonly y: number },
  region?: Box,
): { readonly x: number; readonly y: number } => {
  const centered = { x: at.x - size.width / 2, y: at.y - size.height / 2 };
  if (!region) return { x: Math.round(centered.x), y: Math.round(centered.y) };
  const clampAxis = (start: number, length: number, from: number, span: number): number => {
    const min = from + SQUAD_REGION_PAD;
    const max = from + span - SQUAD_REGION_PAD - length;
    return max < min ? min : Math.min(Math.max(start, min), max);
  };
  return {
    x: Math.round(clampAxis(centered.x, size.width, region.x, region.width)),
    y: Math.round(clampAxis(centered.y, size.height, region.y, region.height)),
  };
};

/** Fresh seats, connections, portraits, and guidance for one placement. */
export const placeSquad = (
  squad: SquadBody,
  at: { readonly x: number; readonly y: number },
  canvas: Canvas | undefined,
  ids: SquadIds,
  launch: SquadLaunch,
): SquadPlacement => {
  const region = findContainingRegion(canvas, at.x, at.y);
  const origin = squadOrigin(squadBounds(squad), at, region);
  const nodes: NodeOf<"agent">[] = [];
  const portraits: Record<string, PortraitOverride> = {};
  const guidance: Record<string, SeatGuidance> = {};
  const skipped: string[] = [];
  const idOfKey = new Map<string, string>();
  const empty = { nodes: [], edges: [], portraits: {}, guidance: {}, skipped: [] };

  for (const seat of squad.seats) {
    if (placeableHarness(seat.profile) === undefined) {
      skipped.push(seat.profile.name);
      continue;
    }
    const x = origin.x + seat.dx;
    const y = origin.y + seat.dy;
    const regionCwd = region
      ? resolveRegionCwd(canvas, x + seat.width / 2, y + seat.height / 2, launch.host)
      : undefined;
    const cwd = regionCwd ?? launch.cwd;
    if (!cwd) return { ...empty, needsFolder: true };
    const placed = seatFromProfile(seat.profile, {
      x,
      y,
      z: (canvas ? topZ(canvas) : 0) + nodes.length,
      host: launch.host,
      ...(launch.agentHost ? { agentHost: launch.agentHost } : {}),
      cwd,
    });
    if (!placed.ok) {
      skipped.push(seat.profile.name);
      continue;
    }
    const node: NodeOf<"agent"> = {
      ...placed.node,
      width: seat.width,
      height: seat.height,
      ...(seat.color ? { color: seat.color } : {}),
    };
    nodes.push(node);
    idOfKey.set(seat.key, node.id);
    if (placed.portrait) portraits[node.id] = placed.portrait;
    if (placed.guidance) guidance[node.id] = placed.guidance;
  }

  const edges: Wire[] = squad.edges.flatMap((edge) => {
    const fromNode = idOfKey.get(edge.from);
    const toNode = idOfKey.get(edge.to);
    if (!fromNode || !toNode || !isVerb(edge.verb)) return [];
    // A mask only ever narrows. Unknown ports fall out; a mask left empty is
    // dropped with its edge, never widened to the verb's full grant.
    const mask = edge.mask?.filter(isPort);
    if (edge.mask && mask?.length === 0) return [];
    return [{
      id: asWireId(ids.edgeId()),
      from: asNodeId(fromNode),
      to: asNodeId(toNode),
      verb: edge.verb,
      ...(mask && mask.length > 0 ? { mask } : {}),
      ...(edge.fromSide && isSide(edge.fromSide) ? { fromSide: edge.fromSide } : {}),
      ...(edge.toSide && isSide(edge.toSide) ? { toSide: edge.toSide } : {}),
    }];
  });

  return {
    nodes,
    edges,
    portraits,
    guidance,
    skipped,
    ...(region ? { regionId: region.id } : {}),
  };
};

/** "3 agents, 2 connections" for picker cards and menu hints. */
export const squadSummary = (squad: SquadBody): string => {
  const seats = squad.seats.length;
  const links = squad.edges.length;
  const agents = `${seats} agent${seats === 1 ? "" : "s"}`;
  return links === 0 ? agents : `${agents}, ${links} connection${links === 1 ? "" : "s"}`;
};
