import { ulid } from "ulid";
import {
  ARTIFACTS_ENABLED,
  BOARD_ENABLED,
  PAD_ENABLED,
  REQUESTS_ENABLED,
  SHEET_ENABLED,
  TASKS_ENABLED,
} from "@shared/features";
import { asNodeId, type NodeOf } from "@shared/model";
import type { Region } from "@shared/model/region";
import { newBinding, requireHostId, seatParts, type SeatChoices } from "@shared/model/seat-parts";
import { AGENT_NODE_SIZE, INSTRUMENT_NODE_SIZE, NOTE_NODE_SIZE } from "./node-geometry";

// Each kind of thing the operator can put on a canvas, as it is when new: its
// id, its size, and the values it starts with. Nothing here adds it; `added`
// in model-edits.ts turns nodes into the command. A new node stacks at the `z`
// its caller gives, which is `topZ(canvas)` for anything dropped on top. What
// a region gives to what is made inside it (a working directory, a page's
// starting address) is read by shared/region-defaults.ts, from the canvas.

/** Where a new node goes and how it stacks. */
export type Spot = { readonly x: number; readonly y: number; readonly z: number };

type Size = { readonly width: number; readonly height: number };
type Launch = NonNullable<NodeOf<"agent">["launch"]>;

const placed = (prefix: string, spot: Spot, size: Size) => ({
  id: asNodeId(`${prefix}-${ulid()}`),
  x: Math.round(spot.x),
  y: Math.round(spot.y),
  width: Math.round(size.width),
  height: Math.round(size.height),
  z: spot.z,
});

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
