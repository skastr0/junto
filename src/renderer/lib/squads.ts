/**
 * Squads, pure: capture a squad template from selected agent seats, and place
 * one as fresh seats. No state, no IPC; callers supply the canvas and ids.
 *
 * Capture
 * - Only agent seats with a managed harness go in, in document order.
 * - Layout is kept relative to the selection's top-left corner.
 * - Connections go in only when both ends are captured seats.
 * - A pinned harness session id in the launch argv becomes
 *   SQUAD_SESSION_TOKEN, so no two placements share a session.
 * - Portraits are captured fully resolved (identity genome plus the
 *   operator's override), because a fresh node id would draw a new face.
 *
 * Place
 * - The squad is centered on the point. Inside a region it is moved to sit
 *   fully inside (so it joins the region); a squad larger than the region
 *   starts at the region's top-left corner.
 * - Every seat gets a new node id, binding id, and (when pinned) session id.
 * - Inside a region with a default folder for the seat's host, the seat
 *   works there; otherwise it keeps the folder it was captured with.
 * - A seat whose harness this build does not know or ships disabled is
 *   skipped, and so is every connection touching it. A connection whose verb
 *   this build does not know is dropped; unknown sides fall away; a port mask
 *   only narrows, and one left with no known port drops its connection.
 * - Opening prompt per seat: its own, else the squad's, else none.
 */
import { Schema } from "effect";
import type { CanvasDoc, CanvasEdge, CanvasNode, TextNode } from "@shared/canvas";
import { CanvasNode as CanvasNodeSchema, EdgeEnd, NodeSide } from "@shared/canvas";
import { Verb } from "@shared/physics/verbs";
import { Port } from "@shared/physics/schema";
import { isHarnessId } from "@shared/managed-terminal-templates";
import { managedHarnessEnabled } from "@shared/features";
import { portraitCharacter, type PortraitConfig } from "@shared/agent-portrait";
import { findContainingRegion, resolveRegionCwd } from "@shared/region-defaults";
import {
  SQUAD_PROMPT_MAX,
  SQUAD_SEATS_MAX,
  SQUAD_SESSION_TOKEN,
  type SquadBody,
  type SquadEdge,
  type SquadPortrait,
  type SquadSeat,
} from "@shared/squads";

/** Gap kept between a placed squad and its region's frame. */
export const SQUAD_REGION_PAD = 32;

const isVerb = Schema.is(Verb);
const isPort = Schema.is(Port);
const isSide = Schema.is(NodeSide);
const isEnd = Schema.is(EdgeEnd);
const isCanvasNode = Schema.is(CanvasNodeSchema);

// --- capture -----------------------------------------------------------------

export type SquadCaptureOptions = {
  /** Saved portrait override for a seat, by node id. */
  readonly portraitOf?: (nodeId: string) => PortraitConfig | undefined;
  /** Squad-wide opening prompt. */
  readonly prompt?: string;
  /** Per-seat opening prompts, by source node id. */
  readonly seatPrompts?: Readonly<Record<string, string>>;
};

/** The agent seats a squad can be made from, in document order. */
export const squadSeatNodes = (
  nodes: ReadonlyArray<CanvasNode>,
  selectedIds: ReadonlyArray<string>,
): TextNode[] => {
  const selected = new Set(selectedIds);
  return nodes.filter(
    (node): node is TextNode =>
      selected.has(node.id) &&
      node.type === "text" &&
      node.ether?.entity?.kind === "agent" &&
      typeof node.ether.terminal?.harness === "string" &&
      node.ether.terminal.launch?.kind === "harness",
  );
};

const cleanPrompt = (text: string | undefined): string | undefined => {
  const trimmed = text?.trim();
  return trimmed ? trimmed.slice(0, SQUAD_PROMPT_MAX) : undefined;
};

/** Every portrait trait, resolved, so a new id draws the same face. */
export const resolvedSquadPortrait = (nodeId: string, override?: PortraitConfig): SquadPortrait => {
  const character = portraitCharacter(nodeId, override);
  return {
    bodyHue: character.bodyHue,
    accentHue: character.accentHue,
    shape: character.shape,
    topper: character.topper,
    eyes: character.eyes,
    mouth: character.mouth,
    brows: character.brows,
    marking: character.marking,
    blush: character.blush,
    temperament: character.temperament,
  };
};

/** Swap a pinned session id in argv for the token (`--flag id` or `--flag=id`). */
export const tokenizeSession = (
  argv: ReadonlyArray<string>,
  sessionId: string | undefined,
): { readonly argv: string[]; readonly pinned: boolean } => {
  if (!sessionId) return { argv: [...argv], pinned: false };
  let pinned = false;
  const next = argv.map((arg) => {
    if (arg === sessionId) {
      pinned = true;
      return SQUAD_SESSION_TOKEN;
    }
    if (arg.endsWith(`=${sessionId}`)) {
      pinned = true;
      return `${arg.slice(0, arg.length - sessionId.length)}${SQUAD_SESSION_TOKEN}`;
    }
    return arg;
  });
  return { argv: next, pinned };
};

/** Capture a squad template from the selection; null when it holds no agent seat. */
export const captureSquad = (
  doc: CanvasDoc,
  selectedIds: ReadonlyArray<string>,
  options: SquadCaptureOptions = {},
): SquadBody | null => {
  const seatsIn = squadSeatNodes(doc.nodes, selectedIds).slice(0, SQUAD_SEATS_MAX);
  if (seatsIn.length === 0) return null;
  const minX = Math.min(...seatsIn.map((node) => node.x));
  const minY = Math.min(...seatsIn.map((node) => node.y));
  const keyOf = new Map(seatsIn.map((node, index) => [node.id, `s${index}`] as const));

  const seats: SquadSeat[] = seatsIn.map((node) => {
    const terminal = node.ether!.terminal!;
    const launch = terminal.launch!;
    const session = tokenizeSession(launch.argv ?? [], terminal.sessionId);
    const prompt = cleanPrompt(options.seatPrompts?.[node.id]);
    return {
      key: keyOf.get(node.id)!,
      harness: terminal.harness!,
      label: (terminal.label ?? node.text).slice(0, 200),
      entityName: String(node.ether!.entity!.name ?? `${node.ether!.host ?? "local"}:${terminal.harness}`),
      host: typeof node.ether!.host === "string" && node.ether!.host ? node.ether!.host : "local",
      launch: {
        argv: session.argv,
        ...(launch.cwd ? { cwd: launch.cwd } : {}),
      },
      ...(session.pinned ? { pinSession: true } : {}),
      dx: Math.round(node.x - minX),
      dy: Math.round(node.y - minY),
      width: node.width,
      height: node.height,
      ...(node.color ? { color: node.color } : {}),
      portrait: resolvedSquadPortrait(node.id, options.portraitOf?.(node.id)),
      ...(prompt ? { prompt } : {}),
    };
  });

  const edges: SquadEdge[] = doc.edges.flatMap((edge) => {
    const from = keyOf.get(edge.fromNode);
    const to = keyOf.get(edge.toNode);
    const verb = edge.ether?.verb;
    if (!from || !to || !verb) return [];
    return [{
      from,
      to,
      verb,
      ...(edge.ether?.mask ? { mask: [...edge.ether.mask] } : {}),
      ...(edge.fromSide ? { fromSide: edge.fromSide } : {}),
      ...(edge.toSide ? { toSide: edge.toSide } : {}),
      ...(edge.fromEnd ? { fromEnd: edge.fromEnd } : {}),
      ...(edge.toEnd ? { toEnd: edge.toEnd } : {}),
      ...(edge.color ? { color: edge.color } : {}),
      ...(edge.label ? { label: edge.label } : {}),
    }];
  });

  const prompt = cleanPrompt(options.prompt);
  return { seats, edges, ...(prompt ? { prompt } : {}) };
};

// --- place -------------------------------------------------------------------

export type SquadIds = {
  readonly nodeId: () => string;
  readonly bindingId: () => string;
  readonly edgeId: () => string;
  readonly sessionId: () => string;
};

export type SquadPlacement = {
  readonly nodes: ReadonlyArray<TextNode>;
  readonly edges: ReadonlyArray<CanvasEdge>;
  /** Portrait override to save for each new seat, by new node id. */
  readonly portraits: Readonly<Record<string, PortraitConfig>>;
  /** Opening prompt to mail each new seat. */
  readonly prompts: ReadonlyArray<{ readonly nodeId: string; readonly bindingId: string; readonly text: string }>;
  /** Labels of seats this build could not place. */
  readonly skipped: ReadonlyArray<string>;
  /** Region the squad landed in, if any. */
  readonly regionId?: string;
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

const seatPlaceable = (seat: SquadSeat): boolean =>
  isHarnessId(seat.harness) && managedHarnessEnabled(seat.harness);

const portraitConfigOf = (portrait: SquadPortrait | undefined): PortraitConfig | undefined =>
  portrait && Object.keys(portrait).length > 0 ? (portrait as PortraitConfig) : undefined;

/** Fresh seats, connections, portraits, and prompts for one placement. */
export const placeSquad = (
  squad: SquadBody,
  at: { readonly x: number; readonly y: number },
  doc: CanvasDoc,
  ids: SquadIds,
): SquadPlacement => {
  const region = findContainingRegion(doc, at.x, at.y);
  const origin = squadOrigin(squadBounds(squad), at, region);
  const nodes: TextNode[] = [];
  const portraits: Record<string, PortraitConfig> = {};
  const prompts: Array<{ nodeId: string; bindingId: string; text: string }> = [];
  const skipped: string[] = [];
  const idOfKey = new Map<string, string>();

  for (const seat of squad.seats) {
    if (!seatPlaceable(seat)) {
      skipped.push(seat.label || seat.harness);
      continue;
    }
    const x = origin.x + seat.dx;
    const y = origin.y + seat.dy;
    const session = seat.pinSession ? ids.sessionId() : undefined;
    const argv = seat.launch.argv.map((arg) =>
      session && arg.includes(SQUAD_SESSION_TOKEN) ? arg.split(SQUAD_SESSION_TOKEN).join(session) : arg,
    );
    const regionCwd = region
      ? resolveRegionCwd(doc, x + seat.width / 2, y + seat.height / 2, seat.host)
      : undefined;
    const cwd = regionCwd ?? seat.launch.cwd;
    const nodeId = ids.nodeId();
    const bindingId = ids.bindingId();
    const node: TextNode = {
      id: nodeId,
      type: "text",
      text: seat.label,
      x,
      y,
      width: seat.width,
      height: seat.height,
      ...(seat.color ? { color: seat.color } : {}),
      ether: {
        entity: { kind: "agent", name: seat.entityName },
        host: seat.host,
        terminal: {
          bindingId,
          label: seat.label,
          harness: seat.harness as NonNullable<NonNullable<TextNode["ether"]>["terminal"]>["harness"],
          launch: { kind: "harness", argv, ...(cwd ? { cwd } : {}) },
          ...(session ? { sessionId: session } : {}),
        },
      },
    };
    if (!isCanvasNode(node)) {
      skipped.push(seat.label || seat.harness);
      continue;
    }
    nodes.push(node);
    idOfKey.set(seat.key, nodeId);
    const portrait = portraitConfigOf(seat.portrait);
    if (portrait) portraits[nodeId] = portrait;
    const text = seat.prompt ?? squad.prompt;
    if (text) prompts.push({ nodeId, bindingId, text });
  }

  const edges: CanvasEdge[] = squad.edges.flatMap((edge) => {
    const fromNode = idOfKey.get(edge.from);
    const toNode = idOfKey.get(edge.to);
    if (!fromNode || !toNode || !isVerb(edge.verb)) return [];
    // A mask only ever narrows. Unknown ports fall out; a mask left empty is
    // dropped with its edge, never widened to the verb's full grant.
    const mask = edge.mask?.filter(isPort);
    if (edge.mask && mask?.length === 0) return [];
    return [{
      id: ids.edgeId(),
      fromNode,
      toNode,
      ...(edge.fromSide && isSide(edge.fromSide) ? { fromSide: edge.fromSide } : {}),
      ...(edge.toSide && isSide(edge.toSide) ? { toSide: edge.toSide } : {}),
      ...(edge.fromEnd && isEnd(edge.fromEnd) ? { fromEnd: edge.fromEnd } : {}),
      ...(edge.toEnd && isEnd(edge.toEnd) ? { toEnd: edge.toEnd } : {}),
      ...(edge.color ? { color: edge.color } : {}),
      ...(edge.label ? { label: edge.label } : {}),
      ether: { verb: edge.verb, ...(mask && mask.length > 0 ? { mask } : {}) },
    }];
  });

  return {
    nodes,
    edges,
    portraits,
    prompts,
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
