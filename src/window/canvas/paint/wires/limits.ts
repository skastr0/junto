/**
 * The numbers and types the engine's wire layer takes from today's wire
 * modules, re-exported so `engine/` imports wires from `paint/wires` alone.
 */

export { SPINE_RADIUS } from "@window/lib/wire-loom";
export { WIRE_PULSE_MAX_ACTIVE, WIRE_PULSE_MS } from "@window/lib/wire-pulse";
export { DERIVE_BACK, DERIVE_TIP, TRACK_ARM, TRACK_SPREAD, TRACK_WIDTH } from "@window/lib/flow-track";
export type { TrackRun } from "@window/lib/flow-track";
