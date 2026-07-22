import { describe, expect, it } from "vitest";
import {
  assessLiveWork,
  buildQuitConfirmPrompt,
  canvasKeyOf,
  countArmedRegions,
  countLiveTimers,
  hasLiveWork,
  QUIT_CONFIRM_ACCEPT_INDEX,
} from "../src/main/vellum/quit-live-work";

describe("quit live-work assessment", () => {
  it("canvasKeyOf splits compound keys", () => {
    expect(canvasKeyOf("ether::region-a")).toBe("ether");
    expect(canvasKeyOf("solo")).toBe("solo");
  });

  it("idle snapshot requires no confirm", () => {
    const snap = assessLiveWork({
      armed: [["ether::r1", false]],
      nextFireKeys: ["ether::timer-1"],
      attachedHerdrStreamCount: 0,
      localTerminalSessionCount: 0,
    });
    expect(snap.armedRegionCount).toBe(0);
    expect(snap.scheduledTimerCount).toBe(0);
    expect(hasLiveWork(snap)).toBe(false);
  });

  it("armed region alone gates quit", () => {
    const snap = assessLiveWork({
      armed: [
        ["ether::r1", true],
        ["ether::r2", false],
      ],
      nextFireKeys: [],
      attachedHerdrStreamCount: 0,
      localTerminalSessionCount: 0,
    });
    expect(snap.armedRegionCount).toBe(1);
    expect(hasLiveWork(snap)).toBe(true);
  });

  it("timers only count on canvases that still have an armed region", () => {
    const armed = [
      ["ether::r1", true],
      ["other::r1", false],
    ] as const;
    expect(countArmedRegions(armed)).toBe(1);
    expect(
      countLiveTimers(["ether::t1", "ether::t2", "other::t9"], new Set(["ether"])),
    ).toBe(2);

    const snap = assessLiveWork({
      armed,
      nextFireKeys: ["ether::t1", "other::t9"],
      attachedHerdrStreamCount: 0,
      localTerminalSessionCount: 0,
    });
    expect(snap.scheduledTimerCount).toBe(1);
    expect(hasLiveWork(snap)).toBe(true);
  });

  it("disarmed canvas timers do not invent live work", () => {
    const snap = assessLiveWork({
      armed: [["ether::r1", false]],
      nextFireKeys: ["ether::t1", "ether::t2"],
      attachedHerdrStreamCount: 0,
      localTerminalSessionCount: 0,
    });
    expect(snap.scheduledTimerCount).toBe(0);
    expect(hasLiveWork(snap)).toBe(false);
  });

  it("attached herdr alone gates quit", () => {
    const snap = assessLiveWork({
      armed: [],
      nextFireKeys: [],
      attachedHerdrStreamCount: 2,
      localTerminalSessionCount: 0,
    });
    expect(hasLiveWork(snap)).toBe(true);
  });

  it("negative herdr counts clamp to zero", () => {
    const snap = assessLiveWork({
      armed: [],
      nextFireKeys: [],
      attachedHerdrStreamCount: -3 as unknown as number,
      localTerminalSessionCount: 0,
    });
    expect(snap.attachedHerdrStreamCount).toBe(0);
    expect(hasLiveWork(snap)).toBe(false);
  });

  it("detached local terminals gate quit because they are stopped", () => {
    const snap = assessLiveWork({
      armed: [],
      nextFireKeys: [],
      attachedHerdrStreamCount: 0,
      localTerminalSessionCount: 2,
    });
    expect(hasLiveWork(snap)).toBe(true);
  });
});

describe("quit confirm prompt", () => {
  it("names what pauses and that herdr survives / is never killed", () => {
    const prompt = buildQuitConfirmPrompt({
      armedRegionCount: 1,
      scheduledTimerCount: 2,
      attachedHerdrStreamCount: 1,
      localTerminalSessionCount: 1,
    });
    expect(prompt.buttons).toEqual(["Cancel", "Quit"]);
    expect(prompt.defaultId).toBe(0);
    expect(prompt.cancelId).toBe(0);
    expect(QUIT_CONFIRM_ACCEPT_INDEX).toBe(1);
    expect(prompt.detail).toMatch(/Watchers, pulses, and kernel timers/i);
    expect(prompt.detail).toMatch(/control sockets/i);
    expect(prompt.detail).toMatch(/never killed/i);
    expect(prompt.detail).toMatch(/Herdr panes and sessions/i);
    expect(prompt.detail).toMatch(/1 armed region/);
    expect(prompt.detail).toMatch(/2 running timers/);
    expect(prompt.detail).toMatch(/1 attached herdr surface/);
    expect(prompt.detail).toMatch(/1 local terminal session/);
    expect(prompt.detail).toMatch(/including detached sessions/);
  });

  it("idle inventory still produces a valid shape (caller should skip dialog)", () => {
    const prompt = buildQuitConfirmPrompt({
      armedRegionCount: 0,
      scheduledTimerCount: 0,
      attachedHerdrStreamCount: 0,
      localTerminalSessionCount: 0,
    });
    expect(prompt.buttons[QUIT_CONFIRM_ACCEPT_INDEX]).toBe("Quit");
  });
});
