import type { CardFact, CardView, PaintEnv, SeatLive, TextRun } from "../src/window/canvas/contract";
import { ringState, type RingStateInput } from "../src/shared/wire/rings";

/** A measure that needs no browser: every glyph is 0.6 of its size wide. */
export const fakeEnv: PaintEnv = {
  measure: (run: TextRun) => run.text.length * run.size * 0.6,
};

export const VIEW: CardView = {
  selected: false,
  hovered: false,
  keyboardFocus: false,
  editing: false,
  dragging: false,
  mode: "dark",
};

export const view = (over: Partial<CardView> = {}): CardView => ({ ...VIEW, ...over });

export const agentFact = (over: { label?: string; ringCap?: number; blocked?: boolean } = {}): CardFact => ({
  id: "agent-1",
  row: { id: "agent-1", kind: "agent", label: over.label ?? "canvas-cards", x: 100, y: 200, width: 216, height: 56, z: 0, agentKey: "local:claude" } as unknown as CardFact["row"],
  derived: { regionDepth: 0, blocked: over.blocked ?? false, z: 0, ...(over.ringCap !== undefined ? { ringCap: over.ringCap } : {}) },
});

export const seatLive = (input: RingStateInput, over: Partial<SeatLive> = {}): SeatLive => ({
  ring: ringState(input),
  line: "running claude",
  mark: { tone: "cyan", label: "working" },
  urgency: 0,
  running: true,
  overseer: false,
  ringSince: 1_000,
  ...over,
});

export const regionFact = (
  over: {
    label?: string;
    color?: string;
    hold?: boolean;
    depth?: number;
    urgency?: CardFact["derived"]["regionUrgency"];
    nameSlot?: CardFact["derived"]["nameSlot"];
    width?: number;
    height?: number;
  } = {},
): CardFact => ({
  id: "region-1",
  row: {
    id: "region-1",
    kind: "region",
    x: 0,
    y: 0,
    width: over.width ?? 400,
    height: over.height ?? 300,
    z: 0,
    hold: over.hold ?? false,
    ...(over.label !== undefined ? { label: over.label } : {}),
    ...(over.color !== undefined ? { color: over.color } : {}),
  } as unknown as CardFact["row"],
  derived: {
    regionDepth: over.depth ?? 0,
    blocked: false,
    z: 0,
    ...(over.urgency !== undefined ? { regionUrgency: over.urgency } : {}),
    ...(over.nameSlot !== undefined ? { nameSlot: over.nameSlot } : {}),
  },
});

import type { KindLive, SpineLive } from "../src/window/canvas/contract";

export const kindFact = (kind: string, live: Partial<KindLive> = {}, ringCap?: number): CardFact => ({
  id: `${kind}-1`,
  row: { id: `${kind}-1`, kind, x: 0, y: 0, width: 216, height: 56, z: 0 } as unknown as CardFact["row"],
  derived: { regionDepth: 0, blocked: false, z: 0, ...(ringCap !== undefined ? { ringCap } : {}) },
  kind: { name: `my ${kind}`, line: "a line", state: "resting", ...live },
});

export const spineFact = (kind: "peer" | "stub", live: Partial<SpineLive> = {}): CardFact => ({
  id: `${kind}-1`,
  row: { id: `${kind}-1`, kind, x: 0, y: 0, width: 220, height: 120, z: 0, label: "studio" } as unknown as CardFact["row"],
  derived: { regionDepth: 0, blocked: false, z: 0 },
  spine: {
    status: "none",
    name: "studio-seat",
    glyph: "Link2",
    hue: "cyan",
    dashed: true,
    rows: [],
    ...live,
  },
});
