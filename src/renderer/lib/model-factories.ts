import { ulid } from "ulid";
import {
  ARTIFACTS_ENABLED,
  BOARD_ENABLED,
  managedHarnessEnabled,
  PAD_ENABLED,
  REQUESTS_ENABLED,
  SHEET_ENABLED,
  TASKS_ENABLED,
} from "@shared/features";
import { sanitizeExtraArgs } from "@shared/launch-extra-args";
import { resolveManagedLaunch } from "@shared/managed-terminal-launch";
import { templateFor, type HarnessId } from "@shared/managed-terminal-templates";
import { asNodeId, type Node, type NodeOf } from "@shared/model";
import type { Canvas } from "@shared/model/canvas";
import type { Region } from "@shared/model/region";
import { isValidStationHostId } from "@shared/station";
import { AGENT_NODE_SIZE, INSTRUMENT_NODE_SIZE, NOTE_NODE_SIZE } from "./node-geometry";

// Each kind of thing the operator can put on a canvas, as it is when new: its
// id, its size, and the values it starts with. Nothing here adds it; `added`
// in model-edits.ts turns nodes into the command. A new node stacks at the `z`
// its caller gives, which is `topZ(canvas)` for anything dropped on top.

/** Where a new node goes and how it stacks. */
export type Spot = { readonly x: number; readonly y: number; readonly z: number };

type Size = { readonly width: number; readonly height: number };
type Launch = NonNullable<NodeOf<"agent">["launch"]>;
type BindingId = NodeOf<"agent">["bindingId"];

const placed = (prefix: string, spot: Spot, size: Size) => ({
  id: asNodeId(`${prefix}-${ulid()}`),
  x: Math.round(spot.x),
  y: Math.round(spot.y),
  width: Math.round(size.width),
  height: Math.round(size.height),
  z: spot.z,
});

const newBinding = (): BindingId => ulid() as BindingId;

const requireHostId = (value: string): string => {
  const host = value.trim();
  if (!isValidStationHostId(host)) {
    throw new Error(`invalid station host id: ${JSON.stringify(value)}`);
  }
  return host;
};

/** A kind this build has off cannot be made, though one already there still shows. */
const requireFeature = (enabled: boolean, label: string): void => {
  if (!enabled) throw new Error(`${label} is disabled in this build`);
};

const SINK_SIZE = { width: 240, height: 120 } as const;
const SCHEDULER_SIZE = { width: 220, height: 96 } as const;

// ── Things that only sit there ──────────────────────────────────────────────

export const newNote = (spot: Spot): NodeOf<"note"> => ({
  kind: "note",
  ...placed("node", spot, NOTE_NODE_SIZE),
  text: "new note",
});

/** Bare text on the map: no card, no connectors. */
export const newLabel = (spot: Spot): NodeOf<"label"> => ({
  kind: "label",
  ...placed("label", spot, { width: 160, height: 40 }),
  text: "Label",
});

/** An image card. `url` is the content store's address of the image. */
export const newImage = (spot: Spot, url: string, size?: Size): NodeOf<"file"> => ({
  kind: "file",
  ...placed("image", spot, size ?? { width: 280, height: 200 }),
  path: url,
});

export const newRegion = (spot: Spot, size?: Size): Region => ({
  kind: "region",
  ...placed("region", spot, size ?? { width: 560, height: 320 }),
  label: "new region",
  hold: false,
});

/** A commit browser over the repository at `cwd`. */
export const newGit = (spot: Spot, cwd: string, label?: string): NodeOf<"git"> => ({
  kind: "git",
  ...placed("git", spot, INSTRUMENT_NODE_SIZE),
  ...(label?.trim() ? { label: label.trim() } : {}),
  cwd,
});

// ── Seats and terminals ─────────────────────────────────────────────────────

/** What the operator chooses when seating an agent. */
export type SeatChoices = {
  readonly harness: HarnessId;
  /** The machine the seat runs on. */
  readonly host: string;
  /** Hermes routing prefix when the host declares a distinct key. */
  readonly agentHost?: string;
  readonly profile?: string;
  readonly model?: string;
  readonly effort?: string;
  /** Named agent mode (Amp `-m low|medium|high|ultra`). */
  readonly mode?: string;
  readonly permissionMode?: string;
  /** Extra harness arguments beyond the dials. */
  readonly extraArgs?: readonly string[];
  readonly cwd?: string;
  readonly label?: string;
};

/** Everything that says which agent runs in a seat and how it is started. */
export type SeatParts = {
  readonly label: string;
  readonly agentKey: string;
  readonly host: string;
  readonly bindingId: BindingId;
  readonly harness: HarnessId;
  readonly launch: Launch;
  /** Minted here for a harness that pins its session, so every wake resumes that one. */
  readonly sessionId?: string;
};

/**
 * Work out a seat from the operator's choices: the one place for the launch
 * rules, shared by a new seat and a reseat. The launch holds arguments only;
 * main adds the seat's environment when it starts it, and no secret is kept.
 */
export const seatParts = (choices: SeatChoices): SeatParts => {
  if (!managedHarnessEnabled(choices.harness)) {
    throw new Error(`managed harness ${choices.harness} is disabled in this build`);
  }
  const host = requireHostId(choices.host);
  const agentHost = requireHostId(choices.agentHost ?? host);
  const template = templateFor(choices.harness);
  const extraArgs = sanitizeExtraArgs(choices.harness, choices.extraArgs).args;
  // A pinning harness wants a UUID for its session flag, and refuses a ULID.
  const sessionId = template.capabilityBadges.sessionId === "pin" ? crypto.randomUUID() : undefined;
  const resolved = resolveManagedLaunch(
    choices.harness,
    {
      ...(choices.profile ? { profile: choices.profile } : {}),
      ...(choices.model ? { model: choices.model } : {}),
      ...(choices.effort ? { effort: choices.effort } : {}),
      ...(choices.mode ? { mode: choices.mode } : {}),
      ...(choices.permissionMode ? { permissionMode: choices.permissionMode } : {}),
      ...(extraArgs.length > 0 ? { extraArgs } : {}),
      ...(choices.cwd ? { cwd: choices.cwd } : {}),
      ...(sessionId ? { sessionId } : {}),
    },
    {},
  );
  const launch: Launch = {
    kind: "harness",
    argv: resolved.argv,
    ...(resolved.cwd ? { cwd: resolved.cwd } : {}),
    ...(extraArgs.length > 0 ? { extraArgs: [...extraArgs] } : {}),
  };
  const agentKey =
    choices.harness === "hermes" && choices.profile
      ? `${agentHost}:${choices.profile}`
      : `${agentHost}:${choices.harness}`;
  const dials = [template.displayName, choices.profile, choices.model, choices.effort, choices.mode].filter(
    (part): part is string => Boolean(part && part.trim()),
  );
  return {
    label: choices.label?.trim() || dials.join(" - "),
    agentKey,
    host,
    bindingId: newBinding(),
    harness: choices.harness,
    launch,
    ...(sessionId ? { sessionId } : {}),
  };
};

/** A seat: an agent with a harness, a terminal session and a mailbox. Never an overseer when new. */
export const newSeat = (spot: Spot, choices: SeatChoices): NodeOf<"agent"> => ({
  kind: "agent",
  ...placed("agent", spot, AGENT_NODE_SIZE),
  ...seatParts(choices),
  overseer: false,
  onRemove: "detach",
});

/** A plain terminal. Its session starts when it is opened. */
export const newTerminal = (
  spot: Spot,
  options: { readonly host?: string; readonly launch?: Launch; readonly label?: string } = {},
): NodeOf<"terminal"> => ({
  kind: "terminal",
  ...placed("terminal", spot, INSTRUMENT_NODE_SIZE),
  ...(options.label?.trim() ? { label: options.label.trim() } : {}),
  host: options.host?.trim() || "local",
  bindingId: newBinding(),
  ...(options.launch ? { launch: options.launch } : {}),
  onRemove: "detach",
});

// ── Surfaces agents work against ────────────────────────────────────────────

/** An in-app browser page. The profile is a name; cookies stay with the browser. */
export const newPage = (
  spot: Spot,
  url: string,
  options: {
    readonly host?: string;
    readonly profile?: string;
    readonly onRemove?: NodeOf<"page">["onRemove"];
  } = {},
): NodeOf<"page"> => ({
  kind: "page",
  ...placed("page", spot, { width: 260, height: 110 }),
  url,
  profile: options.profile?.trim() || "personal",
  host: options.host?.trim() || "local",
  onRemove: options.onRemove ?? "kill-session",
});

export const newTaskBoard = (spot: Spot): NodeOf<"task"> => {
  requireFeature(TASKS_ENABLED, "tasks sink");
  return { kind: "task", ...placed("task", spot, SINK_SIZE) };
};

export const newRequests = (spot: Spot): NodeOf<"requests"> => {
  requireFeature(REQUESTS_ENABLED, "requests sink");
  return { kind: "requests", ...placed("requests", spot, SINK_SIZE) };
};

export const newArtifacts = (spot: Spot): NodeOf<"artifacts"> => {
  requireFeature(ARTIFACTS_ENABLED, "artifacts sink");
  return { kind: "artifacts", ...placed("artifacts", spot, SINK_SIZE) };
};

export const newBoard = (spot: Spot): NodeOf<"board"> => {
  requireFeature(BOARD_ENABLED, "board sink");
  return { kind: "board", ...placed("board", spot, SINK_SIZE) };
};

export const newPad = (spot: Spot): NodeOf<"pad"> => {
  requireFeature(PAD_ENABLED, "pad sink");
  return { kind: "pad", ...placed("pad", spot, SINK_SIZE) };
};

/** A sheet. Its grid is content of its own and starts empty when first read. */
export const newSheet = (spot: Spot): NodeOf<"sheet"> => {
  requireFeature(SHEET_ENABLED, "sheet sink");
  return { kind: "sheet", ...placed("sheet", spot, { width: 260, height: 120 }) };
};

// ── Things that fire on their own ───────────────────────────────────────────

/** A schedule on `host`, every half hour until the operator sets another. */
export const newCron = (spot: Spot, host: string, expression = "*/30 * * * *"): NodeOf<"cron"> => ({
  kind: "cron",
  ...placed("cron", spot, SCHEDULER_SIZE),
  host: requireHostId(host),
  expression,
});

/** A relay: what is wired into it says when it fires, what it is wired to says what it does. */
export const newRelay = (spot: Spot, host: string): NodeOf<"relay"> => ({
  kind: "relay",
  ...placed("relay", spot, SCHEDULER_SIZE),
  host: requireHostId(host),
});

// ── What a region gives to what is made inside it ───────────────────────────
//
// Read once, when the thing is made, and never again. A point is inside a
// region when it lies in the region's rectangle, edges included; where regions
// nest, the smallest that has the value wins.

const innermost = (
  canvas: Canvas,
  x: number,
  y: number,
  has: (region: Region) => boolean,
): Region | undefined => {
  let best: Region | undefined;
  for (const node of canvas.nodes.values()) {
    if (node.kind !== "region") continue;
    if (x < node.x || x > node.x + node.width || y < node.y || y > node.y + node.height) continue;
    if (!has(node)) continue;
    const smaller = best === undefined || node.width * node.height < best.width * best.height;
    const tie = best !== undefined && node.width * node.height === best.width * best.height && node.id < best.id;
    if (smaller || tie) best = node;
  }
  return best;
};

/**
 * The directory a seat or terminal made at this point starts in on `host`:
 * the innermost region that names one for that host. A region with paths for
 * other hosts only is looked past.
 */
export const regionCwdAt = (canvas: Canvas, x: number, y: number, host: string): string | undefined => {
  const key = host.trim();
  if (!key) return undefined;
  const pathOf = (region: Region): string => region.defaults?.paths?.[key]?.trim() ?? "";
  const region = innermost(canvas, x, y, (candidate) => pathOf(candidate).length > 0);
  return region === undefined ? undefined : pathOf(region);
};

export type PageStart = { readonly url?: string; readonly profile?: string; readonly host?: string };

/**
 * What a page made at this point starts with: the whole of the innermost
 * region's page defaults, never a mix of two regions'.
 */
export const regionPageStartAt = (canvas: Canvas, x: number, y: number): PageStart | undefined => {
  const startOf = (region: Region): PageStart => {
    const page = region.defaults?.page;
    const url = page?.url?.trim();
    const profile = page?.profile?.trim();
    const host = page?.host?.trim();
    return { ...(url ? { url } : {}), ...(profile ? { profile } : {}), ...(host ? { host } : {}) };
  };
  const region = innermost(canvas, x, y, (candidate) => Object.keys(startOf(candidate)).length > 0);
  return region === undefined ? undefined : startOf(region);
};

/** The centre of a new node, which is the point its region is read at. */
export const centreOf = (node: Pick<Node, "x" | "y" | "width" | "height">): { readonly x: number; readonly y: number } => ({
  x: node.x + node.width / 2,
  y: node.y + node.height / 2,
});
