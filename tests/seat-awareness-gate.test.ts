/**
 * Seat-awareness enrollment gate — the two decided first impressions.
 *
 * A discovered environment key is not consent. This pins the gate resolution,
 * the settings-backed enrollment flag, and the two disabled paths end to end
 * through the composed plane:
 *
 *   off            no client is constructed, and every observed binding gets
 *                  exactly one judgment-free `not_configured` notice.
 *   on, no key     the same layer runs with a disabled model and publishes
 *                  `missing_key`, so the two facts stay distinguishable.
 *
 * No network is touched: the disabled model constructs no client, and the
 * transport seam is a spy that must never be called.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeSeatAwarenessEvent,
  type SeatAwarenessEvent,
} from "../src/renderer/lib/seat-awareness-contract";
import { defaultSettings, type Settings } from "../src/shared/settings";
import {
  makeSeatAwarenessPlane,
  resolveSeatAwarenessGate,
  seatAwarenessApiKey,
  seatAwarenessEnrolled,
} from "../src/main/junto/term/seat-awareness";
import {
  EVIDENCE_TEXT,
  makeFakePlane,
  makeSnapshot,
} from "./helpers/awareness-fakes";

const settingsWith = (seatAwareness: boolean | undefined): Settings => {
  const settings = defaultSettings();
  return {
    ...settings,
    advanced: { ...settings.advanced, seatAwareness },
  };
};

describe("resolveSeatAwarenessGate", () => {
  it("defaults off when nothing is enrolled and no override is set", () => {
    expect(resolveSeatAwarenessGate({ env: undefined, enrolled: undefined })).toEqual({
      enabled: false,
      source: "default",
    });
    expect(resolveSeatAwarenessGate({ env: undefined, enrolled: false })).toEqual({
      enabled: false,
      source: "default",
    });
  });

  it("turns on only for an explicit settings enrollment", () => {
    expect(resolveSeatAwarenessGate({ env: undefined, enrolled: true })).toEqual({
      enabled: true,
      source: "settings",
    });
  });

  it("lets the dev override win in both directions, case- and space-insensitive", () => {
    expect(resolveSeatAwarenessGate({ env: "on", enrolled: false })).toEqual({
      enabled: true,
      source: "env-on",
    });
    expect(resolveSeatAwarenessGate({ env: " OFF ", enrolled: true })).toEqual({
      enabled: false,
      source: "env-off",
    });
    expect(resolveSeatAwarenessGate({ env: "On", enrolled: undefined }).enabled).toBe(true);
  });

  it("ignores an unrecognized override and falls back to settings", () => {
    expect(resolveSeatAwarenessGate({ env: "yes", enrolled: true })).toEqual({
      enabled: true,
      source: "settings",
    });
    expect(resolveSeatAwarenessGate({ env: "1", enrolled: undefined }).enabled).toBe(false);
  });

  it("reads the settings enrollment flag, absent meaning off", () => {
    expect(seatAwarenessEnrolled(defaultSettings())).toBe(false);
    expect(seatAwarenessEnrolled(settingsWith(undefined))).toBe(false);
    expect(seatAwarenessEnrolled(settingsWith(false))).toBe(false);
    expect(seatAwarenessEnrolled(settingsWith(true))).toBe(true);
  });

  it("discovers the provider key from the environment without requiring it", () => {
    expect(seatAwarenessApiKey({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(seatAwarenessApiKey({ TYPESAFE_API_KEY: "   " } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(seatAwarenessApiKey({ TYPESAFE_API_KEY: " sk-test " } as NodeJS.ProcessEnv)).toBe(
      "sk-test",
    );
  });
});

describe("gate-off first impression", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes one judgment-free not_configured notice per binding and builds no client", () => {
    const fakePlane = makeFakePlane();
    const plane = makeSeatAwarenessPlane();
    const events: SeatAwarenessEvent[] = [];
    plane.subscribe((event) => events.push(event));
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 500 }));

    plane.start({
      enabled: false,
      // A discovered key is not consent: it is passed but must be ignored.
      apiKey: "sk-should-never-be-used",
      plane: fakePlane.plane,
      fetch: fetchSpy,
    });
    expect(plane.isEnabled()).toBe(false);

    fakePlane.publish(makeSnapshot({ bindingId: "s1", epoch: "e1", text: EVIDENCE_TEXT }));
    expect(events).toHaveLength(1);
    const decoded = decodeSeatAwarenessEvent(events[0]);
    expect(decoded?.kind).toBe("assessment");
    if (decoded?.kind !== "assessment") throw new Error("expected an assessment event");
    expect(decoded.assessment.availability).toBe("unavailable");
    expect(decoded.assessment.unavailableReason).toBe("not_configured");
    // Judgment-free: no activity, no concerns, no excerpt, no window.
    expect(decoded.assessment.activity).toBeNull();
    expect(decoded.assessment.concerns).toEqual([]);
    expect(decoded.assessment.absences).toEqual([]);
    expect(decoded.assessment.selectedLineId).toBeNull();
    expect(decoded.assessment.evidence.lines).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();

    // One notice per observed binding: a repaint of the same seat adds nothing.
    fakePlane.publish(makeSnapshot({ bindingId: "s1", epoch: "e1", text: "changed screen" }));
    expect(events).toHaveLength(1);
    // A second seat is a second observed binding and gets its own notice.
    fakePlane.publish(makeSnapshot({ bindingId: "s2", epoch: "e1", text: EVIDENCE_TEXT }));
    expect(events).toHaveLength(2);
    expect(plane.currentEvents()).toHaveLength(2);

    plane.stop();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("replays the notice on a later subscribe for renderer-restart hydration", () => {
    const fakePlane = makeFakePlane();
    const plane = makeSeatAwarenessPlane();
    plane.start({ enabled: false, plane: fakePlane.plane });
    fakePlane.publish(makeSnapshot({ bindingId: "s1", epoch: "e1", text: EVIDENCE_TEXT }));
    const replayed = plane.currentEvents();
    expect(replayed).toHaveLength(1);
    expect(decodeSeatAwarenessEvent(replayed[0])?.kind).toBe("assessment");
    plane.stop();
  });
});

describe("gate-on without a key", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the disabled model and publishes missing_key", () => {
    const fakePlane = makeFakePlane();
    const plane = makeSeatAwarenessPlane();
    const events: SeatAwarenessEvent[] = [];
    plane.subscribe((event) => events.push(event));
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 500 }));

    plane.start({
      enabled: true,
      apiKey: undefined,
      plane: fakePlane.plane,
      fetch: fetchSpy,
      now: () => 1_000_000,
    });
    expect(plane.isEnabled()).toBe(true);

    fakePlane.publish(makeSnapshot({ bindingId: "s1", epoch: "e1", text: EVIDENCE_TEXT }));
    vi.advanceTimersByTime(1_000);

    const decoded = events
      .map((event) => decodeSeatAwarenessEvent(event))
      .find((event) => event?.kind === "assessment");
    expect(decoded?.kind).toBe("assessment");
    if (decoded?.kind !== "assessment") throw new Error("expected an assessment event");
    expect(decoded.assessment.availability).toBe("unavailable");
    // Enrolled but unconfigured is a different fact from the gate being off.
    expect(decoded.assessment.unavailableReason).toBe("missing_key");
    expect(fetchSpy).not.toHaveBeenCalled();

    plane.stop();
  });
});
