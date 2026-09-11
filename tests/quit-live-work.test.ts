import { describe, expect, it } from "vitest";
import {
  assessLiveWork,
  buildQuitConfirmPrompt,
  hasLiveWork,
  QUIT_CONFIRM_ACCEPT_INDEX,
} from "../src/main/vellum-command/quit-live-work";

describe("quit live-work assessment", () => {
  it("idle snapshot requires no confirm", () => {
    const snap = assessLiveWork({ localTerminalSessionCount: 0 });
    expect(hasLiveWork(snap)).toBe(false);
  });

  it("negative counts clamp to zero", () => {
    const snap = assessLiveWork({
      localTerminalSessionCount: -3 as unknown as number,
    });
    expect(snap.localTerminalSessionCount).toBe(0);
    expect(hasLiveWork(snap)).toBe(false);
  });

  it("detached local terminals gate quit because they are stopped", () => {
    const snap = assessLiveWork({ localTerminalSessionCount: 2 });
    expect(hasLiveWork(snap)).toBe(true);
  });
});

describe("quit confirm prompt", () => {
  it("names what pauses and what stops", () => {
    const prompt = buildQuitConfirmPrompt({ localTerminalSessionCount: 1 });
    expect(prompt.buttons).toEqual(["Cancel", "Quit"]);
    expect(prompt.defaultId).toBe(0);
    expect(prompt.cancelId).toBe(0);
    expect(QUIT_CONFIRM_ACCEPT_INDEX).toBe(1);
    expect(prompt.detail).toMatch(/Watchers and kernel timers/i);
    expect(prompt.detail).toMatch(/control sockets/i);
    expect(prompt.detail).toMatch(/1 local terminal session/);
    expect(prompt.detail).toMatch(/including detached sessions/);
    expect(prompt.detail).not.toMatch(/armed region/i);
    expect(prompt.detail).not.toMatch(/pulse/i);
  });

  it("idle inventory still produces a valid shape (caller should skip dialog)", () => {
    const prompt = buildQuitConfirmPrompt({ localTerminalSessionCount: 0 });
    expect(prompt.buttons[QUIT_CONFIRM_ACCEPT_INDEX]).toBe("Quit");
  });
});
