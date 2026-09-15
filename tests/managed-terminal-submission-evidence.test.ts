import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRACKETED_PASTE_START,
  CR,
  INTERRUPT_BYTE,
  ManagedTerminalDrive,
  OperatorInterlock,
  encodeBracketedPaste,
} from "../src/main/vellum-command/term/drive";

describe("positive terminal submission evidence", () => {
  const drives: ManagedTerminalDrive[] = [];
  const makeDrive = (options: ConstructorParameters<typeof ManagedTerminalDrive>[0]) => {
    const drive = new ManagedTerminalDrive({
      pasteToCrSettleMs: 0,
      stallTimeoutMs: 100,
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

  it.each([true, false])("a swallowed paste without an ACK stays unresolved when awaitTurnStart=%s", async (awaitTurnStart) => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const attention: string[] = [];
    const drive = makeDrive({
      isSeatIdle: () => true,
      composerVerdict: () => "empty",
      // Mirrors the fake PTY's paste=swallow: accepted stdin never appears
      // in the composer. Absence is not evidence that Enter was accepted.
      pendingText: () => false,
      pasteChip: () => false,
      write: (_bindingId, data) => { writes.push(data); return true; },
      onAttention: (_bindingId, reason) => attention.push(reason),
    });
    const outcome = drive.writePrompt("seat", "notice swallowed", { awaitTurnStart });
    await vi.advanceTimersByTimeAsync(101);
    await expect(outcome).resolves.toEqual({
      status: "unresolved", reason: "no-turn-start", bindingGeneration: 0,
      writesBefore: 0, writesAfter: 1, pasteWrites: 1, wrotePhysicalBytes: true,
    });
    expect(attention).toEqual(["prompt-stalled"]);
    expect(writes).toEqual([encodeBracketedPaste("notice swallowed"), CR]);

    // Neither idle edges nor an ACK arriving after the bounded attempt can
    // authorize another physical copy of uncertain bytes.
    drive.onTurnStart("seat");
    for (let i = 0; i < 3; i += 1) {
      drive.onSeatIdle("seat");
      drive.onComposerClear("seat");
      await expect(drive.writePrompt("seat", "notice swallowed")).resolves.toMatchObject({
        status: "refused", reason: "written-unresolved", pasteWrites: 0,
        wrotePhysicalBytes: false,
      });
    }
    expect(writes).toEqual([encodeBracketedPaste("notice swallowed"), CR]);
    expect(writes).not.toContain(INTERRUPT_BYTE);
  });

  it.each([true, false])("waits for a delayed actual ACK inside the budget when awaitTurnStart=%s", async (awaitTurnStart) => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const drive = makeDrive({
      isSeatIdle: () => true,
      pendingText: () => false,
      pasteChip: () => false,
      write: (bindingId, data) => {
        writes.push(data);
        if (data === CR) setTimeout(() => drive.onTurnStart(bindingId), 50);
        return true;
      },
    });
    const outcome = drive.writePrompt("seat", "acknowledge me", { awaitTurnStart });
    let settled = false;
    void outcome.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await expect(outcome).resolves.toMatchObject({
      status: "submitted", pasteWrites: 1, wrotePhysicalBytes: true,
    });
    expect(writes).toEqual([encodeBracketedPaste("acknowledge me"), CR]);
  });

  it("disappearing after a recovery CR still needs an actual ACK", async () => {
    vi.useFakeTimers();
    let pending = false;
    let crs = 0;
    const writes: string[] = [];
    const drive = makeDrive({
      isSeatIdle: () => true,
      pendingText: () => pending,
      pasteChip: () => false,
      write: (_bindingId, data) => {
        writes.push(data);
        if (data.startsWith(BRACKETED_PASTE_START)) pending = true;
        if (data === CR && ++crs === 2) pending = false;
        return true;
      },
    });
    const outcome = drive.writePrompt("seat", "literal draft");
    await vi.advanceTimersByTimeAsync(201);
    await expect(outcome).resolves.toMatchObject({
      status: "unresolved", reason: "no-turn-start", pasteWrites: 1,
    });
    expect(writes).toEqual([encodeBracketedPaste("literal draft"), CR, CR]);
    await expect(drive.writePrompt("seat", "literal draft")).resolves.toMatchObject({
      status: "refused", reason: "written-unresolved", pasteWrites: 0,
    });
    expect(writes).toHaveLength(3);
  });

  it("the constructor shortcut cannot receipt accepted bytes without an ACK", async () => {
    vi.useFakeTimers();
    const drive = makeDrive({
      isSeatIdle: () => true,
      stallWatch: false,
      write: () => true,
    });
    const outcome = drive.writePrompt("seat", "unobserved");
    await vi.advanceTimersByTimeAsync(101);
    await expect(outcome).resolves.toMatchObject({
      status: "unresolved", reason: "no-turn-start", pasteWrites: 1,
    });
  });

  it.each(["turn-start", "compact-noop"] as const)("preserves positive %s observed before the writer resolves", async (proof) => {
    const drive = makeDrive({
      isSeatIdle: () => true,
      pendingText: () => false,
      pasteChip: () => false,
      write: (bindingId, data) => {
        if (data === CR) {
          if (proof === "turn-start") drive.onTurnStart(bindingId);
          else drive.onCompactNoop(bindingId);
        }
        return true;
      },
    });
    await expect(drive.writePrompt("seat", proof === "compact-noop" ? "/compact" : "notice"))
      .resolves.toMatchObject({ status: "submitted", pasteWrites: 1 });
  });
});
