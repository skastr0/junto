/**
 * Occupancy reads a seat's needs through OCCUPANCY_FROM_NEED, on the one
 * need ladder; the harness state is only the fallback.
 */
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  deriveNeeds,
  initialSnapshot,
  reduceSeatSignals,
  type SeatSignal,
  type SignalEnvelope,
  type SignalSource,
} from "../src/shared/harness-domain";
import { BindingId } from "../src/shared/terminal-session-domain";
import { DEFAULT_STALL_AFTER_MS, deriveOccupancy } from "../src/shared/occupancy/derive";

const seat = Schema.decodeSync(BindingId)("b-o");
let clock = 1_000;
const at = (source: SignalSource, signal: SeatSignal): SignalEnvelope => ({
  seat,
  at: (clock += 10),
  source,
  fidelity: "native",
  signal,
});
const needsOf = (...signals: SignalEnvelope[]) => deriveNeeds(reduceSeatSignals(initialSnapshot(seat, 0), signals));
const NOW = 10_000_000;

describe("occupancy from needs", () => {
  it("a usage limit stops the seat: activity_blocked, which the harness path never produced", () => {
    const needs = needsOf(at("screen", { _tag: "TurnStarted" }), at("screen", { _tag: "UsageLimitHit", scope: "5h", message: "limit reached" }));
    expect(deriveOccupancy({ hasOccupant: true, needs, nowMs: NOW })).toBe("activity_blocked");
  });

  it("a prompt waiting on the operator reads attention", () => {
    const needs = needsOf(at("screen", { _tag: "PermissionRequested" }));
    expect(deriveOccupancy({ hasOccupant: true, needs, activity: { harness: "blocked" }, nowMs: NOW })).toBe("attention");
  });

  it("a stale heartbeat still reads stalled over working", () => {
    const needs = needsOf(at("screen", { _tag: "TurnStarted" }));
    const lastSeenAtMs = NOW - DEFAULT_STALL_AFTER_MS - 1;
    expect(deriveOccupancy({ hasOccupant: true, needs, lastSeenAtMs, nowMs: NOW })).toBe("stalled");
  });

  it("without needs, attention outranks blocked on the harness path too", () => {
    expect(deriveOccupancy({ hasOccupant: true, activity: { harness: "attention" }, nowMs: NOW })).toBe("attention");
    expect(deriveOccupancy({ hasOccupant: true, activity: { harness: "blocked" }, nowMs: NOW })).toBe("activity_blocked");
  });
});
