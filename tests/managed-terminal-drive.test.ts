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
import {
  makeManagedPulseDeliver,
  scheduleManagedPulseReady,
  subscribeManagedPulseReady,
} from "../src/main/vellum/term/managed-pulse-bridge";

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

  const flushMicrotasks = async (ticks = 2) => {
    for (let i = 0; i < ticks; i += 1) await Promise.resolve();
  };

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
    vi.useRealTimers();
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

  it("refuses a non-queuing busy prompt without writing it on a later idle transition", async () => {
    idle = false;
    drive = makeDrive();

    await expect(
      drive.writePrompt("b1", "scheduled pulse", { queueIfBusy: false }),
    ).resolves.toBe(false);
    expect(drive.queuedCount("b1")).toBe(0);
    expect(writes).toEqual([]);

    idle = true;
    drive.onSeatIdle("b1");
    await flushMicrotasks();
    expect(writes).toEqual([]);
  });

  it("managed pulse handoff samples readiness and always disables the drive queue", async () => {
    const calls: Array<{
      bindingId: string;
      text: string;
      options: Parameters<typeof drive.writePrompt>[2];
    }> = [];
    let ready = false;
    const pulse = makeManagedPulseDeliver(
      async (bindingId, text, options) => {
        calls.push({ bindingId, text, options });
        return true;
      },
      () => ready,
    );

    await expect(pulse("b1", "first")).resolves.toBe(true);
    ready = true;
    await expect(pulse("b1", "second")).resolves.toBe(true);

    expect(calls).toEqual([
      {
        bindingId: "b1",
        text: "first",
        options: { ready: false, queueIfBusy: false },
      },
      {
        bindingId: "b1",
        text: "second",
        options: { ready: true, queueIfBusy: false },
      },
    ]);
  });

  it("publishes one payload-free readiness wake at an explicit guard boundary", async () => {
    vi.useFakeTimers();
    const events: Array<{ bindingId: string; epoch: string }> = [];
    const unsubscribe = subscribeManagedPulseReady((event) => {
      events.push(event);
    });

    scheduleManagedPulseReady(
      { bindingId: "grok-seat", epoch: "generation-1" },
      1_500,
      () => true,
    );

    await vi.advanceTimersByTimeAsync(1_499);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toEqual([
      { bindingId: "grok-seat", epoch: "generation-1" },
    ]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events).toHaveLength(1);

    unsubscribe();
  });

  it("cancels or rejects stale readiness guards without publishing", async () => {
    vi.useFakeTimers();
    const events: Array<{ bindingId: string; epoch: string }> = [];
    const unsubscribe = subscribeManagedPulseReady((event) => {
      events.push(event);
    });

    const cancel = scheduleManagedPulseReady(
      { bindingId: "grok-seat", epoch: "generation-1" },
      1_500,
      () => true,
    );
    cancel();
    scheduleManagedPulseReady(
      { bindingId: "grok-seat", epoch: "generation-2" },
      1_500,
      () => false,
    );

    await vi.advanceTimersByTimeAsync(1_500);
    expect(events).toEqual([]);

    unsubscribe();
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

    vi.advanceTimersByTime(5_000);
    await flushMicrotasks();
    // Retry once.
    expect(writes).toHaveLength(4);
    expect(attention).toEqual([]);

    vi.advanceTimersByTime(5_000);
    await flushMicrotasks();
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
    vi.advanceTimersByTime(10_000);
    await flushMicrotasks();
    expect(writes).toHaveLength(2);
    expect(attention).toEqual([]);
    vi.useRealTimers();
  });

  it("never carries queued or retrying text across a terminal generation", async () => {
    vi.useFakeTimers();
    try {
      drive = makeDrive({
        stallWatch: true,
        stallTimeoutMs: 5_000,
      });
      await expect(drive.writePrompt("b1", "old generation")).resolves.toBe(
        true,
      );
      expect(writes).toHaveLength(2);

      idle = false;
      const queued = drive.writePrompt("b1", "also old");
      expect(drive.queuedCount("b1")).toBe(1);

      drive.invalidateBinding("b1");
      await expect(queued).resolves.toBe(false);
      expect(drive.queuedCount("b1")).toBe(0);

      idle = true;
      drive.onSeatIdle("b1");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(writes).toHaveLength(2);

      await expect(drive.writePrompt("b1", "new generation")).resolves.toBe(
        true,
      );
      expect(writes.slice(2)).toEqual([
        { bindingId: "b1", data: encodeBracketedPaste("new generation") },
        { bindingId: "b1", data: CR },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not submit CR after the binding changes during paste", async () => {
    let releasePaste!: (ok: boolean) => void;
    const pasteResult = new Promise<boolean>((resolve) => {
      releasePaste = resolve;
    });
    drive = makeDrive({
      write: (bindingId, data) => {
        writes.push({ bindingId, data });
        return writes.length === 1 ? pasteResult : true;
      },
    });

    const writing = drive.writePrompt("b1", "old generation");
    await flushMicrotasks();
    drive.invalidateBinding("b1");
    releasePaste(true);

    await expect(writing).resolves.toBe(false);
    expect(writes).toEqual([
      { bindingId: "b1", data: encodeBracketedPaste("old generation") },
    ]);
  });

  it("suspends queued prompts and stall retries without writing or signaling the PTY", async () => {
    vi.useFakeTimers();
    try {
      drive = makeDrive({
        stallWatch: true,
        stallTimeoutMs: 5_000,
      });
      await expect(
        drive.writePrompt("b1", "awaiting turn"),
      ).resolves.toBe(true);
      expect(writes).toHaveLength(2);

      idle = false;
      const queued = drive.writePrompt("b1", "queued");
      expect(drive.queuedCount("b1")).toBe(1);

      drive.suspend();
      await expect(queued).resolves.toBe(false);
      expect(drive.queuedCount("b1")).toBe(0);

      idle = true;
      drive.onSeatIdle("b1");
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(drive.writePrompt("b1", "late")).resolves.toBe(
        false,
      );
      await expect(drive.interrupt("b1")).resolves.toBe(false);
      expect(writes).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not submit CR when revocation lands during an admitted paste write", async () => {
    let releasePaste!: (ok: boolean) => void;
    const pasteResult = new Promise<boolean>((resolve) => {
      releasePaste = resolve;
    });
    drive = makeDrive({
      write: (bindingId, data) => {
        writes.push({ bindingId, data });
        return writes.length === 1 ? pasteResult : true;
      },
    });

    const writing = drive.writePrompt("b1", "in flight");
    await flushMicrotasks();
    expect(writes).toEqual([
      {
        bindingId: "b1",
        data: encodeBracketedPaste("in flight"),
      },
    ]);

    drive.suspend();
    releasePaste(true);

    await expect(writing).resolves.toBe(false);
    expect(writes).toHaveLength(1);
  });
});
