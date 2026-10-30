import { describe, expect, it } from "vitest";
import {
  assessLiveWork,
  buildQuitConfirmPrompt,
  hasLiveWork,
  probeLiveWork,
  QUIT_CONFIRM_ACCEPT_INDEX,
} from "../src/main/junto/quit-live-work";

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

  it("counts the sessions a quit would stop, from whatever owner answers", async () => {
    const snap = await probeLiveWork(async () => [
      { status: "running" },
      { status: "starting" },
      { status: "exited" },
      { status: "missing" },
    ]);
    expect(snap).toEqual({ localTerminalSessionCount: 2, countUnknown: false });
    expect(hasLiveWork(snap)).toBe(true);
  });

  it("a probe that rejects is unknown: the operator is warned, never told zero", async () => {
    const snap = await probeLiveWork(async () => {
      throw new Error("the core process exited with code 0");
    });
    expect(snap).toEqual({ localTerminalSessionCount: 0, countUnknown: true });
    expect(hasLiveWork(snap)).toBe(true);
    expect(buildQuitConfirmPrompt(snap).detail).toMatch(/did not answer how many/);
  });

  it("a core that did not answer is unknown, not zero: the operator is warned", () => {
    const snap = assessLiveWork({ localTerminalSessionCount: "unknown" });
    expect(snap.countUnknown).toBe(true);
    expect(snap.localTerminalSessionCount).toBe(0);
    expect(hasLiveWork(snap)).toBe(true);
    const prompt = buildQuitConfirmPrompt(snap);
    expect(prompt.detail).toMatch(/did not answer how many/);
    expect(prompt.detail).not.toMatch(/0 local terminal sessions/);
  });
});

describe("quit confirm prompt", () => {
  it("names what pauses and what stops", () => {
    const prompt = buildQuitConfirmPrompt(assessLiveWork({ localTerminalSessionCount: 1 }));
    expect(prompt.buttons).toEqual(["Cancel", "Quit"]);
    expect(prompt.defaultId).toBe(0);
    expect(prompt.cancelId).toBe(0);
    expect(QUIT_CONFIRM_ACCEPT_INDEX).toBe(1);
    expect(prompt.detail).toMatch(/Automations and schedules on this machine/i);
    expect(prompt.detail).not.toMatch(/watcher|timer/i);
    expect(prompt.detail).toMatch(/control sockets/i);
    expect(prompt.detail).toMatch(/1 local terminal session/);
    expect(prompt.detail).toMatch(/including detached sessions/);
    expect(prompt.detail).not.toMatch(/armed region/i);
    expect(prompt.detail).not.toMatch(/pulse/i);
  });

  it("idle inventory still produces a valid shape (caller should skip dialog)", () => {
    const prompt = buildQuitConfirmPrompt(assessLiveWork({ localTerminalSessionCount: 0 }));
    expect(prompt.buttons[QUIT_CONFIRM_ACCEPT_INDEX]).toBe("Quit");
  });
});
