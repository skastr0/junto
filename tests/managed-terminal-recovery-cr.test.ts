import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CR,
  ManagedTerminalDrive,
  OperatorInterlock,
  encodeBracketedPaste,
} from "../src/main/vellum-command/term/drive";

describe("recovery CR (harness-owned selector submit)", () => {
  const drives: ManagedTerminalDrive[] = [];
  const makeDrive = (
    options: Partial<ConstructorParameters<typeof ManagedTerminalDrive>[0]> = {},
  ) => {
    const drive = new ManagedTerminalDrive({
      write: () => true,
      isSeatIdle: () => true,
      pasteToCrSettleMs: 0,
      stallWatch: false,
      operatorInput: new OperatorInterlock(),
      ...options,
    });
    drives.push(drive);
    return drive;
  };
  afterEach(() => {
    for (const drive of drives.splice(0)) drive.resetForTest();
    vi.useRealTimers();
  });

  it("writes one bare CR on a clean binding without opening a turn", async () => {
    const writes: string[] = [];
    const drive = makeDrive({
      write: (_bindingId, data) => { writes.push(data); return true; },
    });
    await expect(drive.submitRecoveryCr("seat")).resolves.toBe(true);
    expect(writes).toEqual([CR]);
    // No turn was opened: a prompt afterwards still delivers normally.
    await expect(drive.writePrompt("seat", "hello")).resolves.toBe(true);
    expect(writes).toEqual([CR, encodeBracketedPaste("hello"), CR]);
  });

  it("refuses while a paste is unresolved instead of submitting the stuck chip", async () => {
    const writes: string[] = [];
    const attention: string[] = [];
    const drive = makeDrive({
      write: (_bindingId, data) => { writes.push(data); return true; },
      pendingText: () => true,
      onAttention: (_bindingId, reason) => { attention.push(reason); },
    });
    await expect(drive.writePrompt("seat", "first\nprompt")).resolves.toBe(false);
    const before = writes.length;
    await expect(drive.submitRecoveryCr("seat")).resolves.toBe(false);
    expect(writes).toHaveLength(before);
    expect(attention).toContain("prompt-stalled");
    // The wedge is preserved, not papered over: later prompts still refuse.
    await expect(drive.writePrompt("seat", "retry")).resolves.toBe(false);
    expect(writes).toHaveLength(before);
  });

  it("refuses while a submission span is in flight", async () => {
    let releasePaste!: (ok: boolean) => void;
    const gate = new Promise<boolean>((resolve) => { releasePaste = resolve; });
    const writes: string[] = [];
    const drive = makeDrive({
      write: (_bindingId, data) => {
        writes.push(data);
        return data === CR ? true : gate;
      },
    });
    const prompt = drive.writePrompt("seat", "in flight");
    await Promise.resolve();
    await expect(drive.submitRecoveryCr("seat")).resolves.toBe(false);
    releasePaste(true);
    await expect(prompt).resolves.toBe(true);
    expect(writes).toEqual([encodeBracketedPaste("in flight"), CR]);
  });
});
