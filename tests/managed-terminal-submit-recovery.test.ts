import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRACKETED_PASTE_START,
  CR,
  INTERRUPT_BYTE,
  ManagedTerminalDrive,
  OPERATOR_RESIZE_LATCH_MS,
  OperatorInterlock,
  encodeBracketedPaste,
} from "../src/main/vellum-command/term/drive";

describe("submission recovery ownership", () => {
  const drives: ManagedTerminalDrive[] = [];
  const makeDrive = (options: ConstructorParameters<typeof ManagedTerminalDrive>[0]) => {
    const drive = new ManagedTerminalDrive({
      pasteToCrSettleMs: 0,
      stallWatch: false,
      operatorInput: new OperatorInterlock(),
      ...options,
    });
    drives.push(drive);
    return drive;
  };
  const flush = async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };
  afterEach(() => {
    for (const drive of drives.splice(0)) drive.resetForTest();
    vi.useRealTimers();
  });

  it.each(["paste", "recipe CR"] as const)("waits out resize arriving at %s before the next submit CR", async (phase) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const interlock = new OperatorInterlock();
    const writes: Array<{ data: string; resizeActive: boolean }> = [];
    let pending = false;
    let crs = 0;
    const drive = makeDrive({
      operatorInput: interlock,
      isSeatIdle: () => true,
      pendingText: () => pending,
      pasteChip: () => phase === "recipe CR" && pending,
      write: (bindingId, data) => {
        writes.push({ data, resizeActive: interlock.resizeActive(bindingId) });
        if (data.startsWith(BRACKETED_PASTE_START)) {
          pending = true;
          if (phase === "paste") interlock.noteResize(bindingId);
        } else if (data === CR) {
          crs += 1;
          if (phase === "recipe CR" && crs === 1) interlock.noteResize(bindingId);
          else pending = false;
        }
        return true;
      },
    });
    const result = drive.writePrompt("seat", phase === "paste" ? "literal" : "one\ntwo");
    await flush();
    await vi.advanceTimersByTimeAsync(OPERATOR_RESIZE_LATCH_MS - 1);
    expect(crs).toBe(phase === "paste" ? 0 : 1);
    await vi.advanceTimersByTimeAsync(2);
    await expect(result).resolves.toEqual({
      status: "submitted", bindingGeneration: 0,
      writesBefore: 0, writesAfter: 1, pasteWrites: 1, wrotePhysicalBytes: true,
    });
    expect(writes.filter(({ data }) => data === CR).every(({ resizeActive }) => !resizeActive)).toBe(true);
  });

  it.each([false, true])("recovers an eaten submit for chip=%s without re-pasting or forcing attention", async (chip) => {
    vi.useFakeTimers();
    let idle = true;
    let pending = false;
    let crs = 0;
    const writes: string[] = [];
    const attention: string[] = [];
    const drive = makeDrive({
      isSeatIdle: () => idle,
      pendingText: () => pending,
      pasteChip: () => chip && pending,
      stallWatch: true,
      stallTimeoutMs: 10,
      onAttention: (_bindingId, reason) => { attention.push(reason); idle = false; },
      write: (bindingId, data) => {
        writes.push(data);
        if (data.startsWith(BRACKETED_PASTE_START)) pending = true;
        if (data === CR && ++crs === (chip ? 3 : 2)) {
          pending = false;
          drive.onTurnStart(bindingId);
        }
        return true;
      },
    });
    const result = drive.writePrompt("seat", chip ? "one\ntwo" : "factory notice");
    await vi.advanceTimersByTimeAsync(30);
    await expect(result).resolves.toEqual({
      status: "submitted", bindingGeneration: 0,
      writesBefore: 0, writesAfter: 1, pasteWrites: 1, wrotePhysicalBytes: true,
    });
    expect(crs).toBe(chip ? 3 : 2);
    expect(drive.pasteWriteCount("seat")).toBe(1);
    expect(attention).toEqual([]);
    expect(writes).not.toContain(INTERRUPT_BYTE);
  });

  it("never recovers across operator input even after its activity latch expires", async () => {
    vi.useFakeTimers();
    const interlock = new OperatorInterlock();
    const writes: string[] = [];
    const drive = makeDrive({
      operatorInput: interlock,
      isSeatIdle: () => true,
      pendingText: () => true,
      pasteChip: () => false,
      stallWatch: true,
      stallTimeoutMs: 1000,
      write: (_bindingId, data) => { writes.push(data); return true; },
    });
    const result = drive.writePrompt("seat", "factory notice");
    await flush();
    interlock.noteInput("seat");
    await vi.advanceTimersByTimeAsync(1100);
    expect(interlock.inputActive("seat")).toBe(false);
    await expect(result).resolves.toEqual({
      status: "unresolved", reason: "chip-pending", bindingGeneration: 0,
      writesBefore: 0, writesAfter: 1, pasteWrites: 1, wrotePhysicalBytes: true,
    });
    expect(writes).toEqual([encodeBracketedPaste("factory notice"), CR]);
  });

  it("queue admission expiry cannot resolve a prompt after its paste starts", async () => {
    vi.useFakeTimers();
    let idle = false;
    let pending = true;
    const drive = makeDrive({
      isSeatIdle: () => idle,
      pendingText: () => pending,
      pasteChip: () => false,
      stallWatch: true,
      stallTimeoutMs: 1000,
      write: () => true,
    });
    const result = drive.writePrompt("seat", "queued notice", { queueTimeoutMs: 10 });
    idle = true;
    drive.onSeatIdle("seat");
    await flush();
    let settled = false;
    void result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(20);
    expect(drive.pasteWriteCount("seat")).toBe(1);
    expect(settled).toBe(false);
    pending = false;
    drive.onTurnStart("seat");
    await expect(result).resolves.toEqual({
      status: "submitted", bindingGeneration: 0,
      writesBefore: 0, writesAfter: 1, pasteWrites: 1, wrotePhysicalBytes: true,
    });
  });

  it("late cleanup from a replaced generation cannot unlock or overwrite the current submission", async () => {
    const interlock = new OperatorInterlock();
    const writes: string[] = [];
    const release: Array<(accepted: boolean) => void> = [];
    const drive = makeDrive({
      operatorInput: interlock,
      isSeatIdle: () => true,
      composerVerdict: () => "empty",
      pendingText: () => false,
      pasteChip: () => false,
      write: (_bindingId, data) => {
        writes.push(data);
        if (data !== CR) return new Promise<boolean>((resolve) => release.push(resolve));
        return true;
      },
    });
    const old = drive.writePrompt("seat", "old", { queueIfBusy: false });
    drive.invalidateBinding("seat");
    const current = drive.writePrompt("seat", "current", { queueIfBusy: false });
    release[0]!(true);
    // Replacement revokes acknowledgement authority, but cannot erase the
    // accepted bytes or turn this into a safe pre-write retry.
    await expect(old).resolves.toEqual({
      status: "unresolved", reason: "no-turn-start", bindingGeneration: 0,
      writesBefore: 0, writesAfter: 1, pasteWrites: 1, wrotePhysicalBytes: true,
    });
    expect(interlock.holding("seat")).toBe(true);
    const blocked = await drive.writePrompt("seat", "third", { queueIfBusy: false });
    expect(blocked).toMatchObject({
      status: "refused", reason: "seat-busy", bindingGeneration: 1,
      pasteWrites: 0, wrotePhysicalBytes: false,
    });
    expect(blocked.writesAfter).toBe(blocked.writesBefore);
    release[1]!(true);
    const accepted = await current;
    expect(accepted).toMatchObject({
      status: "submitted", bindingGeneration: 1, pasteWrites: 1, wrotePhysicalBytes: true,
    });
    expect(accepted.writesAfter - accepted.writesBefore).toBe(1);
    expect(writes).toEqual([encodeBracketedPaste("old"), encodeBracketedPaste("current"), CR]);
  });

  it.each(["first ACK", "recovery write", "retry ACK"] as const)("cannot receipt a replaced generation during %s", async (phase) => {
    vi.useFakeTimers();
    let pending = true;
    let crs = 0;
    let releaseRecovery!: (accepted: boolean) => void;
    const drive = makeDrive({
      isSeatIdle: () => true,
      pendingText: () => pending,
      pasteChip: () => false,
      stallWatch: true,
      stallTimeoutMs: 10,
      write: (_bindingId, data) => {
        if (data === CR && ++crs === 2 && phase === "recovery write") {
          return new Promise<boolean>((resolve) => { releaseRecovery = resolve; });
        }
        return true;
      },
    });
    const old = drive.writePrompt("seat", "old notice");
    await flush();
    if (phase === "first ACK") {
      pending = false;
      drive.onTurnStart("seat");
      drive.invalidateBinding("seat");
    } else {
      await vi.advanceTimersByTimeAsync(11);
      expect(crs).toBe(2);
      drive.invalidateBinding("seat");
      if (phase === "recovery write") {
        drive.onTurnStart("seat");
        releaseRecovery(true);
      }
    }
    await expect(old).resolves.toEqual({
      status: "unresolved", reason: "no-turn-start", bindingGeneration: 0,
      writesBefore: 0, writesAfter: 1, pasteWrites: 1, wrotePhysicalBytes: true,
    });
  });

});
