import { describe, expect, it } from "vitest";
import {
  assessLiveWork,
  buildQuitConfirmPrompt,
  hasLiveWork,
  QUIT_CONFIRM_ACCEPT_INDEX,
} from "../src/main/vellum/quit-live-work";

describe("quit live-work assessment", () => {
  it("idle snapshot requires no confirm", () => {
    const snap = assessLiveWork({
      attachedHerdrStreamCount: 0,
      localTerminalSessionCount: 0,
    });
    expect(hasLiveWork(snap)).toBe(false);
  });

  it("attached herdr alone gates quit", () => {
    const snap = assessLiveWork({
      attachedHerdrStreamCount: 2,
      localTerminalSessionCount: 0,
    });
    expect(hasLiveWork(snap)).toBe(true);
  });

  it("negative herdr counts clamp to zero", () => {
    const snap = assessLiveWork({
      attachedHerdrStreamCount: -3 as unknown as number,
      localTerminalSessionCount: 0,
    });
    expect(snap.attachedHerdrStreamCount).toBe(0);
    expect(hasLiveWork(snap)).toBe(false);
  });

  it("detached local terminals gate quit because they are stopped", () => {
    const snap = assessLiveWork({
      attachedHerdrStreamCount: 0,
      localTerminalSessionCount: 2,
    });
    expect(hasLiveWork(snap)).toBe(true);
  });
});

describe("quit confirm prompt", () => {
  it("names what pauses and that herdr survives / is never killed", () => {
    const prompt = buildQuitConfirmPrompt({
      attachedHerdrStreamCount: 1,
      localTerminalSessionCount: 1,
    });
    expect(prompt.buttons).toEqual(["Cancel", "Quit"]);
    expect(prompt.defaultId).toBe(0);
    expect(prompt.cancelId).toBe(0);
    expect(QUIT_CONFIRM_ACCEPT_INDEX).toBe(1);
    expect(prompt.detail).toMatch(/Watchers and kernel timers/i);
    expect(prompt.detail).toMatch(/control sockets/i);
    expect(prompt.detail).toMatch(/never killed/i);
    expect(prompt.detail).toMatch(/Herdr panes and sessions/i);
    expect(prompt.detail).toMatch(/1 attached herdr surface/);
    expect(prompt.detail).toMatch(/1 local terminal session/);
    expect(prompt.detail).toMatch(/including detached sessions/);
    expect(prompt.detail).not.toMatch(/armed region/i);
    expect(prompt.detail).not.toMatch(/pulse/i);
  });

  it("idle inventory still produces a valid shape (caller should skip dialog)", () => {
    const prompt = buildQuitConfirmPrompt({
      attachedHerdrStreamCount: 0,
      localTerminalSessionCount: 0,
    });
    expect(prompt.buttons[QUIT_CONFIRM_ACCEPT_INDEX]).toBe("Quit");
  });
});
