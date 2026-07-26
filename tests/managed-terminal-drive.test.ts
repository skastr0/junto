import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  CR,
  INTERRUPT_BYTE,
  ManagedTerminalDrive,
  buildPromptWriteSequence,
  canSendIdleInterrupt,
  encodeBracketedPaste,
} from "../src/main/vellum/term/drive";

describe("typing recipe", () => {
  it("encodes bracketed paste as one envelope", () => {
    expect(encodeBracketedPaste("hello")).toBe(
      `${BRACKETED_PASTE_START}hello${BRACKETED_PASTE_END}`,
    );
  });

  it("splits paste and CR into two writes — never joins, never LF", () => {
    const [paste, cr] = buildPromptWriteSequence("line1\nline2");
    expect(paste).toBe(`${BRACKETED_PASTE_START}line1\nline2${BRACKETED_PASTE_END}`);
    expect(cr).toBe(CR);
    expect(cr).not.toBe("\n");
    expect(paste + cr).not.toBe(paste); // two distinct ops
    // Joining would be the Codex trap — sequence keeps them separate.
    expect(buildPromptWriteSequence("x")).toHaveLength(2);
  });

  it("idle interrupt spacing rejects sub-1s gaps", () => {
    expect(canSendIdleInterrupt(undefined, 1000)).toBe(true);
    expect(canSendIdleInterrupt(1000, 1999)).toBe(false);
    expect(canSendIdleInterrupt(1000, 2000)).toBe(true);
  });
});

describe("ManagedTerminalDrive", () => {
  const writes: Array<{ bindingId: string; data: string }> = [];
  let idle = true;
  let clock = 10_000;
  let drive: ManagedTerminalDrive;

  const makeDrive = (
    over: Partial<ConstructorParameters<typeof ManagedTerminalDrive>[0]> = {},
  ) =>
    new ManagedTerminalDrive({
      write: (bindingId, data) => {
        writes.push({ bindingId, data });
        return true;
      },
      isSeatIdle: () => idle,
      now: () => clock,
      stallWatch: false,
      ...over,
    });

  afterEach(() => {
    drive?.resetForTest();
    writes.length = 0;
    idle = true;
    clock = 10_000;
  });

  it("writePrompt issues paste then separate CR", async () => {
    drive = makeDrive();
    const ok = await drive.writePrompt("b1", "do work");
    expect(ok).toBe(true);
    expect(writes).toEqual([
      { bindingId: "b1", data: encodeBracketedPaste("do work") },
      { bindingId: "b1", data: CR },
    ]);
    expect(writes[0]!.data).not.toContain(CR);
    expect(writes[1]!.data).toBe("\r");
  });

  it("idle gate queues when busy and drains one on idle transition", async () => {
    idle = false;
    drive = makeDrive();
    const p1 = drive.writePrompt("b1", "first");
    const p2 = drive.writePrompt("b1", "second");
    expect(writes).toEqual([]);
    expect(drive.queuedCount("b1")).toBe(2);

    idle = true;
    drive.onSeatIdle("b1");
    await expect(p1).resolves.toBe(true);
    expect(writes.map((w) => w.data)).toEqual([
      encodeBracketedPaste("first"),
      CR,
    ]);
    expect(drive.queuedCount("b1")).toBe(1);

    // Still one turn at a time — second waits for next idle pulse.
    drive.onSeatIdle("b1");
    await expect(p2).resolves.toBe(true);
    expect(writes.map((w) => w.data)).toEqual([
      encodeBracketedPaste("first"),
      CR,
      encodeBracketedPaste("second"),
      CR,
    ]);
  });

  it("clipboard-unsafe aborts without clearing clipboard or writing", async () => {
    const attention: string[] = [];
    drive = makeDrive({
      assertClipboardSafe: async () => false,
      onAttention: (_id, reason) => attention.push(reason),
    });
    const ok = await drive.writePrompt("b1", "nope");
    expect(ok).toBe(false);
    expect(writes).toEqual([]);
    expect(attention).toEqual(["clipboard-unsafe"]);
  });

  it("not-ready aborts without writing (Hermes positive-signal gate)", async () => {
    drive = makeDrive();
    const ok = await drive.writePrompt("b1", "early", { ready: false });
    expect(ok).toBe(false);
    expect(writes).toEqual([]);
  });

  it("interrupt is 0x03 only; idle spacing blocks rapid double Ctrl+C", async () => {
    drive = makeDrive();
    expect(await drive.interrupt("b1")).toBe(true);
    expect(writes).toEqual([{ bindingId: "b1", data: INTERRUPT_BYTE }]);
    expect(INTERRUPT_BYTE).toBe("\u0003");

    // Second idle interrupt too soon.
    clock = 10_000 + 500;
    expect(await drive.interrupt("b1")).toBe(false);
    expect(writes).toHaveLength(1);

    // After 1s gap — allowed.
    clock = 10_000 + 1_000;
    expect(await drive.interrupt("b1")).toBe(true);
    expect(writes).toHaveLength(2);
  });

  it("mid-turn interrupt is never spacing-gated", async () => {
    idle = false;
    drive = makeDrive();
    expect(await drive.interrupt("b1")).toBe(true);
    clock += 10;
    expect(await drive.interrupt("b1")).toBe(true);
    expect(writes).toEqual([
      { bindingId: "b1", data: INTERRUPT_BYTE },
      { bindingId: "b1", data: INTERRUPT_BYTE },
    ]);
  });

  it("stall: no turn-start → retry once → attention", async () => {
    vi.useFakeTimers();
    const attention: string[] = [];
    drive = makeDrive({
      stallWatch: true,
      stallTimeoutMs: 5_000,
      onAttention: (_id, reason) => attention.push(reason),
    });
    const ok = await drive.writePrompt("b1", "stalled");
    expect(ok).toBe(true);
    expect(writes).toHaveLength(2); // paste + CR

    await vi.advanceTimersByTimeAsync(5_000);
    // Retry once.
    expect(writes).toHaveLength(4);
    expect(attention).toEqual([]);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(attention).toEqual(["prompt-stalled"]);
    // No third full write pair after attention.
    expect(writes).toHaveLength(4);

    vi.useRealTimers();
  });

  it("stall cleared by onTurnStart — no retry", async () => {
    vi.useFakeTimers();
    const attention: string[] = [];
    drive = makeDrive({
      stallWatch: true,
      stallTimeoutMs: 5_000,
      onAttention: (_id, reason) => attention.push(reason),
    });
    await drive.writePrompt("b1", "ok");
    drive.onTurnStart("b1");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(writes).toHaveLength(2);
    expect(attention).toEqual([]);
    vi.useRealTimers();
  });
});
