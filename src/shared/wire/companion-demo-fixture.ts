/**
 * The companion demo's data, and nothing else: the regions, seats, signals,
 * mail history, health readings and clock that `junto companion-stdio --demo`
 * serves. A wire module (effect-only closure), so another client (the in-app
 * demo transport in junto-app) can sync the same fixture instead of copying
 * it. The projections that turn it into feeds and seats live in
 * `src/shared/companion-demo.ts`.
 */

import type { AgentSignal } from "./agent-signals";
import type { CompanionActivity, CompanionMail, CompanionPreamble } from "./companion-protocol";
import type { ThreadHealthValue } from "./thread-health";

export const DEMO_CANVAS = "demo";
export const DEMO_CANVAS_TITLE = "Demo";
export const DEMO_DEVICE_ID = "dev_00000000000000000000DEM000";
export const DEMO_DEVICE_NAME = "Demo phone";
export const DEMO_STATION = "Junto demo";
/** 2026-09-21T16:26:40Z. Every demo timestamp is relative to it. */
export const DEMO_T0 = 1_790_000_000_000;
const MIN = 60_000;
/** When the attention seat's dialog appeared, and the seats' last activity. */
export const DEMO_ACTIVITY_AT = DEMO_T0 - 2 * MIN;
/** When every health reading was observed (fresh at DEMO_T0). */
export const DEMO_HEALTH_OBSERVED_AT = DEMO_T0 - MIN;
export const DEMO_HEALTH_CONFIDENCE = 0.93;

export type DemoRegion = {
  readonly id: string;
  readonly label: string;
  /** JSON Canvas preset color. */
  readonly color: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export const DEMO_REGIONS: ReadonlyArray<DemoRegion> = [
  { id: "r-backend", label: "Backend", color: "4", x: 0, y: 0, width: 900, height: 700 },
  { id: "r-frontend", label: "Frontend", color: "5", x: 1000, y: 0, width: 900, height: 700 },
  { id: "r-research", label: "Research", color: "6", x: 2000, y: 0, width: 900, height: 700 },
];

/** The seat state machine's words (`AgentSeatState`). */
export type DemoControlState = "idle" | "working" | "attention" | "unknown" | "gone";

export type DemoSeat = {
  readonly id: string;
  readonly name: string;
  readonly harness: string;
  /** Left edge of the seat's region; the seat sits inside it. */
  readonly regionX: number;
  readonly slot: number;
  readonly control: DemoControlState;
  readonly reason?: string;
  readonly process: "running" | "starting" | "stopped";
  readonly doneUnread?: boolean;
  readonly health?: ThreadHealthValue;
};

/** Seat geometry on the canvas, inside its region. */
export const demoSeatPosition = (seat: DemoSeat): { readonly x: number; readonly y: number } => ({
  x: seat.regionX + 40 + seat.slot * 280,
  y: 120,
});

export const DEMO_SEATS: ReadonlyArray<DemoSeat> = [
  { id: "atlas", name: "Atlas", harness: "claude", regionX: 0, slot: 0, control: "idle", process: "running" },
  { id: "forge", name: "Forge", harness: "codex", regionX: 0, slot: 1, control: "attention", reason: "permission prompt", process: "running" },
  { id: "relay", name: "Relay", harness: "claude", regionX: 0, slot: 2, control: "working", process: "running", health: "going_well" },
  { id: "quill", name: "Quill", harness: "claude", regionX: 1000, slot: 0, control: "idle", process: "running" },
  { id: "prism", name: "Prism", harness: "amp", regionX: 1000, slot: 1, control: "idle", process: "running", doneUnread: true },
  { id: "ember", name: "Ember", harness: "codex", regionX: 1000, slot: 2, control: "idle", process: "running", health: "waiting_on_operator" },
  { id: "sage", name: "Sage", harness: "hermes", regionX: 2000, slot: 0, control: "working", process: "running", health: "thrashing" },
  { id: "lumen", name: "Lumen", harness: "claude", regionX: 2000, slot: 1, control: "idle", process: "stopped" },
];

export const DEMO_SIGNALS: ReadonlyArray<AgentSignal> = [
  {
    signalId: "sig_demo_blocked",
    canvasName: DEMO_CANVAS,
    nodeId: "atlas",
    kind: "blocked",
    text: "Need the staging database password to run the migration.",
    detail: "The migration step reads `STAGING_DB_URL`. It is not set in this shell.",
    createdAt: DEMO_T0 - 12 * MIN,
    state: "open",
  },
  {
    signalId: "sig_demo_escalate",
    canvasName: DEMO_CANVAS,
    nodeId: "quill",
    kind: "escalate",
    text: "Should the empty state use the illustration or plain text?",
    createdAt: DEMO_T0 - 7 * MIN,
    state: "open",
  },
  {
    signalId: "sig_demo_feedback",
    canvasName: DEMO_CANVAS,
    nodeId: "prism",
    kind: "feedback",
    text: "The pricing page is ready for review.",
    detail: "- New tier table\n- Annual toggle\n- FAQ moved below the fold",
    createdAt: DEMO_T0 - 3 * MIN,
    state: "open",
  },
];

/** Mail as the demo stores it; the canvas name is added on the way out. */
export type DemoMail = Omit<CompanionMail, "canvasName">;

export const DEMO_MAIL: ReadonlyArray<DemoMail> = [
  { messageId: "01J9DEMOMAIL0000000000000A1", nodeId: "atlas", direction: "to_seat", from: { kind: "operator" }, text: "Run the schema migration against staging.", at: DEMO_T0 - 40 * MIN, delivery: "delivered" },
  { messageId: "01J9DEMOMAIL0000000000000A2", nodeId: "atlas", direction: "to_seat", from: { kind: "seat", nodeId: "relay", name: "Relay" }, text: "The API tests pass on my branch.", at: DEMO_T0 - 25 * MIN, delivery: "delivered" },
  { messageId: "01J9DEMOMAIL0000000000000A3", nodeId: "atlas", direction: "from_seat", from: { kind: "seat", nodeId: "atlas", name: "Atlas" }, text: "Relay, hold the deploy until the migration lands.", at: DEMO_T0 - 20 * MIN, delivery: "delivered" },
  { messageId: "01J9DEMOMAIL0000000000000B1", nodeId: "quill", direction: "to_seat", from: { kind: "operator" }, text: "Design the empty state for the inbox.", at: DEMO_T0 - 30 * MIN, delivery: "delivered" },
  { messageId: "01J9DEMOMAIL0000000000000C1", nodeId: "lumen", direction: "to_seat", from: { kind: "operator" }, text: "Summarize the three papers when you are back.", at: DEMO_T0 - 5 * MIN, delivery: "waiting_for_seat" },
];

export const DEMO_QUICK_REPLIES: ReadonlyArray<string> = ["Yes, go ahead.", "No, stop here.", "Use your judgment.", "I'll look at it shortly."];

/** Region briefings, markdown, as the region's kind strip holds them. */
export const DEMO_BRIEFINGS: Readonly<Record<string, string>> = {
  "r-backend": "Ship the billing migration this week.\n\n- Staging first, then production\n- No schema change without a rollback script",
  "r-frontend": "Pricing and inbox polish for the launch.",
};

/** Live notes per seat, newest first. Every one is still live at DEMO_T0. */
export const DEMO_PREAMBLES: Readonly<Record<string, ReadonlyArray<CompanionPreamble>>> = {
  atlas: [
    { preambleId: "pre_demo_atlas_2", text: "Waiting on the staging password before the migration.", source: "agent", at: DEMO_T0 - 11 * MIN, expiresAt: DEMO_T0 + 30 * MIN },
    { preambleId: "pre_demo_atlas_1", text: "Dry run of the migration passed.", source: "junto", at: DEMO_T0 - 15 * MIN, expiresAt: DEMO_T0 + 20 * MIN },
  ],
  relay: [
    { preambleId: "pre_demo_relay_1", text: "Running the API test suite.", source: "agent", at: DEMO_T0 - 2 * MIN, expiresAt: DEMO_T0 + 10 * MIN },
  ],
  sage: [
    { preambleId: "pre_demo_sage_1", text: "Retrying the same search with small changes.", source: "ai", at: DEMO_T0 - MIN, expiresAt: DEMO_T0 + 5 * MIN },
  ],
};

/** The seat sidebar's Activity, per seat, newest first. */
export const DEMO_ACTIVITY: Readonly<Record<string, ReadonlyArray<CompanionActivity>>> = {
  atlas: [
    { at: DEMO_T0 - 12 * MIN, label: "raised blocked", kind: "signal" },
    { at: DEMO_T0 - 20 * MIN, label: "sent mail", kind: "mail", targetName: "Relay" },
    { at: DEMO_T0 - 25 * MIN, label: "got mail", kind: "mail", targetName: "Relay" },
    { at: DEMO_T0 - 40 * MIN, label: "started working", kind: "state" },
  ],
  forge: [{ at: DEMO_T0 - 2 * MIN, label: "asked for permission", kind: "state" }],
  relay: [
    { at: DEMO_T0 - 2 * MIN, label: "started working", kind: "state" },
    { at: DEMO_T0 - 25 * MIN, label: "sent mail", kind: "mail", targetName: "Atlas" },
  ],
  quill: [{ at: DEMO_T0 - 7 * MIN, label: "raised escalate", kind: "signal" }],
  prism: [
    { at: DEMO_T0 - 3 * MIN, label: "raised feedback", kind: "signal" },
    { at: DEMO_T0 - 4 * MIN, label: "finished", kind: "state" },
  ],
  lumen: [{ at: DEMO_T0 - 30 * MIN, label: "stopped", kind: "state" }],
};
