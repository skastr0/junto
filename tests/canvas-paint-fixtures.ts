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
