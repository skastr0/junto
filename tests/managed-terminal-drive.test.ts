import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  CR,
  INTERRUPT_BYTE,
  ManagedTerminalDrive,
  OPERATOR_INPUT_LATCH_MS,
  OperatorInterlock,
  buildPromptWriteSequence,
  canSendIdleInterrupt,
  encodeBracketedPaste,
  hermesRefusesMultilinePaste,
  payloadMayChip,
} from "../src/main/vellum-command/term/drive";
import {
  makeManagedPulseDeliver,
  scheduleManagedPulseReady,
  subscribeManagedPulseReady,
} from "../src/main/vellum-command/term/managed-pulse-bridge";

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

  it("a newline is the chip trigger; one-liners never chip", () => {
    expect(payloadMayChip("hello")).toBe(false);
    expect(payloadMayChip("one\ntwo")).toBe(true);
    expect(payloadMayChip("hello\n")).toBe(true);
  });

  it("hermes refuses a multiline body and admits a one-liner", () => {
    expect(hermesRefusesMultilinePaste("hermes", "one\ntwo")).toBe(true);
    expect(hermesRefusesMultilinePaste("hermes", "hello")).toBe(false);
    expect(hermesRefusesMultilinePaste("claude", "one\ntwo")).toBe(false);
    expect(hermesRefusesMultilinePaste(undefined, "one\ntwo")).toBe(false);
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
      // Unit tests assert paste+CR write counts without advancing real timers.
      pasteToCrSettleMs: 0,
      ...over,
    });

  afterEach(() => {
    drive?.resetForTest();
    writes.length = 0;
    idle = true;
    clock = 10_000;
    vi.useRealTimers();
  });

  it("refuses an already cancelled prompt without touching the worker", async () => {
    drive = makeDrive();
    const controller = new AbortController();
    controller.abort();
    expect(await drive.writePrompt("b1", "obsolete", { signal: controller.signal })).toBe(false);
    expect(writes).toEqual([]);
  });

  it("does not submit or clear a prompt cancelled while its paste is in flight", async () => {
    let releasePaste!: (ok: boolean) => void;
    const paste = new Promise<boolean>((resolve) => { releasePaste = resolve; });
    drive = makeDrive({
      write: (bindingId, data) => { writes.push({ bindingId, data }); return paste; },
      pendingText: () => true,
    });
    const controller = new AbortController();
    const result = drive.writePrompt("b1", "obsolete", { signal: controller.signal });
    expect(writes).toEqual([{ bindingId: "b1", data: encodeBracketedPaste("obsolete") }]);
    controller.abort();
    releasePaste(true);
    expect(await result).toBe(false);
    expect(writes).toHaveLength(1);
  });

  it("drops a cancelled queued prompt before the worker becomes idle", async () => {
    idle = false;
    drive = makeDrive();
    const controller = new AbortController();
    const result = drive.writePrompt("b1", "obsolete", { signal: controller.signal });
    expect(drive.queuedCount("b1")).toBe(1);
    controller.abort();
    expect(await result).toBe(false);
    expect(drive.queuedCount("b1")).toBe(0);
    idle = true;
    drive.onSeatIdle("b1");
    await flushMicrotasks();
    expect(writes).toEqual([]);
  });

  it("ends a cancelled acknowledgement wait without a recovery write", async () => {
    drive = makeDrive({ stallWatch: true, stallTimeoutMs: 10_000, pendingText: () => true });
    const controller = new AbortController();
    const result = drive.writePrompt("b1", "obsolete", { signal: controller.signal });
    await flushMicrotasks(10);
    expect(writes.map(({ data }) => data)).toEqual([encodeBracketedPaste("obsolete"), CR]);
    controller.abort();
    expect(await result).toBe(false);
    expect(writes).toHaveLength(2);
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

  it("chip-submit CR ignores payload-head pendingText when pasteChip is false", async () => {
    const local: Array<{ bindingId: string; data: string }> = [];
    drive = makeDrive({
      write: (bindingId, data) => {
        local.push({ bindingId, data });
        return true;
      },
      pendingText: () => true,
      pasteChip: () => false,
    });
    await expect(drive.writePrompt("b1", "one\ntwo")).resolves.toBe(true);
    expect(local.map((w) => w.data)).toEqual([
      encodeBracketedPaste("one\ntwo"),
      CR,
    ]);
  });

  it("multiline paste sends an immediate chip-submit CR while idle and pending", async () => {
    let pending = false;
    const local: Array<{ bindingId: string; data: string }> = [];
    drive = makeDrive({
      write: (bindingId, data) => {
        local.push({ bindingId, data });
        if (data.startsWith(BRACKETED_PASTE_START)) pending = true;
        if (data === CR && local.filter((w) => w.data === CR).length >= 2) {
          pending = false;
        }
        return true;
      },
      pendingText: () => pending,
    });
    await expect(drive.writePrompt("b1", "one\ntwo")).resolves.toBe(true);
    expect(local.map((w) => w.data)).toEqual([
      encodeBracketedPaste("one\ntwo"),
      CR,
      CR,
    ]);
  });

  it("hermes refuses a multiline paste at the write boundary — zero writes, attention", async () => {
    const attention: string[] = [];
    drive = makeDrive({
      harnessFor: () => "hermes",
      onAttention: (_id, reason) => attention.push(reason),
    });
    await expect(drive.writePrompt("b1", "one\ntwo")).resolves.toBe(false);
    expect(writes).toEqual([]);
    expect(attention).toEqual(["multiline-refused"]);
  });

  it("hermes still accepts a one-line paste", async () => {
    drive = makeDrive({ harnessFor: () => "hermes" });
    await expect(drive.writePrompt("b1", "do work")).resolves.toBe(true);
    expect(writes).toEqual([
      { bindingId: "b1", data: encodeBracketedPaste("do work") },
      { bindingId: "b1", data: CR },
    ]);
  });

  it("firstTyped waits a second settle so a late chip is not receipted", async () => {
    vi.useFakeTimers();
    let chip = false;
    const local: Array<{ bindingId: string; data: string }> = [];
    drive = makeDrive({
      stallWatch: false,
      pasteToCrSettleMs: 40,
      write: (bindingId, data) => {
        local.push({ bindingId, data });
        if (data.startsWith(BRACKETED_PASTE_START)) {
          // After recipe CR + chip-CR settle (80ms), before firstTyped settle 2.
          setTimeout(() => {
            chip = true;
          }, 90);
        }
        if (data === INTERRUPT_BYTE) chip = false;
        return true;
      },
      pendingText: () => chip,
      pasteChip: () => chip,
    });
    const p = drive.writePrompt("b1", "one\ntwo", { awaitTurnStart: false });
    await vi.advanceTimersByTimeAsync(40); // paste settle + CR
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(40); // chip-CR settle — still no chrome
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(40); // firstTyped settle 1 — chip still late
    await flushMicrotasks();
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(40); // firstTyped settle 2 — chip painted
    await expect(p).resolves.toBe(false);
    expect(local.map((w) => w.data)).toEqual([
      encodeBracketedPaste("one\ntwo"),
      CR,
      INTERRUPT_BYTE,
    ]);
    vi.useRealTimers();
  }, 15_000);

  it("firstTyped does not receipt a stuck multiline chip — clears and returns false", async () => {
    let pending = false;
    const local: Array<{ bindingId: string; data: string }> = [];
    drive = makeDrive({
      write: (bindingId, data) => {
        local.push({ bindingId, data });
        if (data.startsWith(BRACKETED_PASTE_START)) pending = true;
        if (data === INTERRUPT_BYTE) pending = false;
        return true;
      },
      pendingText: () => pending,
    });
    await expect(
      drive.writePrompt("b1", "one\ntwo", { awaitTurnStart: false }),
    ).resolves.toBe(false);
    expect(local.map((w) => w.data)).toEqual([
      encodeBracketedPaste("one\ntwo"),
      CR,
      CR,
      INTERRUPT_BYTE,
    ]);
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

  it("mail steering interrupts a busy seat once, then drains prompts at idle", async () => {
    idle = false;
    drive = makeDrive();

    const first = drive.writePrompt("b1", "mail one", { interruptIfBusy: true });
    const second = drive.writePrompt("b1", "mail two", { interruptIfBusy: true });
    await flushMicrotasks(4);

    expect(writes).toEqual([{ bindingId: "b1", data: INTERRUPT_BYTE }]);
    expect(drive.queuedCount("b1")).toBe(2);

    idle = true;
    drive.onSeatIdle("b1");
    await expect(first).resolves.toBe(true);
    expect(writes.map((w) => w.data)).toEqual([
      INTERRUPT_BYTE,
      encodeBracketedPaste("mail one"),
      CR,
    ]);

    drive.onSeatIdle("b1");
    await expect(second).resolves.toBe(true);
    expect(writes.map((w) => w.data)).toEqual([
      INTERRUPT_BYTE,
      encodeBracketedPaste("mail one"),
      CR,
      encodeBracketedPaste("mail two"),
      CR,
    ]);
  });

  it("mail steering never interrupts an idle seat", async () => {
    drive = makeDrive();
    await expect(
      drive.writePrompt("b1", "mail", { interruptIfBusy: true }),
    ).resolves.toBe(true);
    expect(writes).toEqual([
      { bindingId: "b1", data: encodeBracketedPaste("mail") },
      { bindingId: "b1", data: CR },
    ]);
  });

  it("does not strand mail when idle arrives before the interrupt write settles", async () => {
    idle = false;
    let releaseInterrupt!: (ok: boolean) => void;
    const interruptWritten = new Promise<boolean>((resolve) => {
      releaseInterrupt = resolve;
    });
    drive = makeDrive({
      write: (bindingId, data) => {
        writes.push({ bindingId, data });
        return data === INTERRUPT_BYTE ? interruptWritten : true;
      },
    });

    const mail = drive.writePrompt("b1", "mail", { interruptIfBusy: true });
    await flushMicrotasks(3);
    expect(writes).toEqual([{ bindingId: "b1", data: INTERRUPT_BYTE }]);

    idle = true;
    drive.onSeatIdle("b1");
    releaseInterrupt(true);
    await expect(mail).resolves.toBe(true);
    expect(writes.map((w) => w.data)).toEqual([
      INTERRUPT_BYTE,
      encodeBracketedPaste("mail"),
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

  it("stall: no turn-start and no chip chrome → false + clear, no retry CR", async () => {
    vi.useFakeTimers();
    const attention: string[] = [];
    drive = makeDrive({
      stallWatch: true,
      stallTimeoutMs: 5_000,
      onAttention: (_id, reason) => attention.push(reason),
    });
    const result = drive.writePrompt("b1", "stalled");
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(writes).toHaveLength(2); // paste + CR
    expect(settled).toBe(false);

    // Recovery CR is chip-chrome only. No pasteChip / pendingText → clear.
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toBe(false);
    expect(attention).toEqual(["prompt-stalled", "prompt-stalled"]);
    expect(writes).toEqual([
      { bindingId: "b1", data: encodeBracketedPaste("stalled") },
      { bindingId: "b1", data: CR },
      { bindingId: "b1", data: INTERRUPT_BYTE },
    ]);

    vi.useRealTimers();
  });

  it("stall: late chip chrome still gets one recovery CR", async () => {
    vi.useFakeTimers();
    let chip = false;
    const attention: string[] = [];
    drive = makeDrive({
      stallWatch: true,
      stallTimeoutMs: 5_000,
      pendingText: () => true,
      pasteChip: () => chip,
      onAttention: (_id, reason) => attention.push(reason),
    });
    const result = drive.writePrompt("b1", "one\ntwo");
    await flushMicrotasks(10);
    expect(writes).toHaveLength(2); // paste + CR, no recipe chip CR yet
    chip = true;
    await vi.advanceTimersByTimeAsync(5_000);
    await flushMicrotasks(4);
    expect(writes).toHaveLength(3); // recovery CR
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toBe(false);
    expect(writes.at(-1)).toMatchObject({ data: INTERRUPT_BYTE });
    expect(attention.length).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it("turn-start is the receipt-facing acceptance acknowledgement", async () => {
    vi.useFakeTimers();
    const attention: string[] = [];
    drive = makeDrive({
      stallWatch: true,
      stallTimeoutMs: 5_000,
      onAttention: (_id, reason) => attention.push(reason),
    });
    const delivered = drive.writePrompt("b1", "ok");
    let settled = false;
    void delivered.then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);

    drive.onTurnStart("b1");
    await expect(delivered).resolves.toBe(true);
    vi.advanceTimersByTime(10_000);
    await flushMicrotasks();
    expect(writes).toHaveLength(2);
    expect(attention).toEqual([]);
    vi.useRealTimers();
  });

  it("does not lose a turn-start that races the CR writer completion", async () => {
    drive = makeDrive({
      stallWatch: true,
      write: (bindingId, data) => {
        writes.push({ bindingId, data });
        if (data === CR) drive.onTurnStart(bindingId);
        return true;
      },
    });

    await expect(drive.writePrompt("b1", "fast turn")).resolves.toBe(true);
    expect(writes).toHaveLength(2);
  });

  it("accepts Claude's fresh-session compact no-op without acknowledging other prompts", async () => {
    drive = makeDrive({ stallWatch: true });

    const compact = drive.writePrompt("b1", "/compact");
    await flushMicrotasks();
    drive.onCompactNoop("b1");
    await expect(compact).resolves.toBe(true);

    const task = drive.writePrompt("b1", "[factory claim] task-1");
    await flushMicrotasks();
    drive.onCompactNoop("b1");
    let settled = false;
    void task.then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);
    drive.onTurnStart("b1");
    await expect(task).resolves.toBe(true);
  });

  it("does not lose a compact no-op that races the CR writer completion", async () => {
    drive = makeDrive({
      stallWatch: true,
      write: (bindingId, data) => {
        writes.push({ bindingId, data });
        if (data === CR) drive.onCompactNoop(bindingId);
        return true;
      },
    });

    await expect(drive.writePrompt("b1", "/compact")).resolves.toBe(true);
    expect(writes).toHaveLength(2);
  });

  it("managed pulse reports a stalled prompt as refused for durable receipt logic", async () => {
    vi.useFakeTimers();
    try {
      drive = makeDrive({
        stallWatch: true,
        stallTimeoutMs: 5_000,
      });
      const pulse = makeManagedPulseDeliver(
        (bindingId, text, options) =>
          drive.writePrompt(bindingId, text, options),
        () => true,
      );

      const accepted = pulse("b1", "kernel pulse");
      await flushMicrotasks();
      expect(writes).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(5_000);
      await expect(accepted).resolves.toBe(false);
      // No chip chrome → no recovery CR; one idle Ctrl+C clear.
      expect(writes).toHaveLength(3);
      expect(writes[2]).toMatchObject({ data: INTERRUPT_BYTE });
    } finally {
      vi.useRealTimers();
    }
  });

  it("never carries queued or awaiting-ack text across a terminal generation", async () => {
    vi.useFakeTimers();
    try {
      drive = makeDrive({
        stallWatch: true,
        stallTimeoutMs: 5_000,
      });
      const awaitingTurn = drive.writePrompt("b1", "old generation");
      await flushMicrotasks();
      expect(writes).toHaveLength(2);

      const queued = drive.writePrompt("b1", "also old");
      expect(drive.queuedCount("b1")).toBe(1);

      drive.invalidateBinding("b1");
      await expect(awaitingTurn).resolves.toBe(false);
      await expect(queued).resolves.toBe(false);
      expect(drive.queuedCount("b1")).toBe(0);

      idle = true;
      drive.onSeatIdle("b1");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(writes).toHaveLength(2);

      const newGeneration = drive.writePrompt("b1", "new generation");
      await flushMicrotasks();
      drive.onTurnStart("b1");
      await expect(newGeneration).resolves.toBe(true);
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

  it("suspends queued prompts and pending acknowledgements without writing or signaling the PTY", async () => {
    vi.useFakeTimers();
    try {
      drive = makeDrive({
        stallWatch: true,
        stallTimeoutMs: 5_000,
      });
      const awaitingTurn = drive.writePrompt("b1", "awaiting turn");
      await flushMicrotasks();
      expect(writes).toHaveLength(2);

      idle = false;
      const queued = drive.writePrompt("b1", "queued");
      expect(drive.queuedCount("b1")).toBe(1);

      drive.suspend();
      await expect(awaitingTurn).resolves.toBe(false);
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

describe("composer verdict gate (screen truth)", () => {
  const writes: Array<{ bindingId: string; data: string }> = [];
  let idle = true;
  let verdict: "empty" | "draft" | null = "empty";
  let drive: ManagedTerminalDrive;

  const makeDrive = () =>
    new ManagedTerminalDrive({
      write: (bindingId, data) => {
        writes.push({ bindingId, data });
        return true;
      },
      isSeatIdle: () => idle,
      composerVerdict: () => verdict,
      stallWatch: false,
      pasteToCrSettleMs: 0,
    });

  afterEach(() => {
    drive?.resetForTest();
    writes.length = 0;
    idle = true;
    verdict = "empty";
  });

  it("proven-empty composer types", async () => {
    drive = makeDrive();
    await expect(drive.writePrompt("b1", "notice")).resolves.toBe(true);
    expect(writes.map((w) => w.data)).toEqual([
      encodeBracketedPaste("notice"),
      CR,
    ]);
  });

  it("a visible draft holds the prompt and releases on composer clear", async () => {
    verdict = "draft";
    drive = makeDrive();
    const pending = drive.writePrompt("b1", "notice");
    expect(writes).toEqual([]);
    expect(drive.queuedCount("b1")).toBe(1);

    // Operator submits or clears; the screen proves empty; delivery flows.
    verdict = "empty";
    drive.onComposerClear("b1");
    await expect(pending).resolves.toBe(true);
    expect(writes.map((w) => w.data)).toEqual([
      encodeBracketedPaste("notice"),
      CR,
    ]);
  });

  it("an unreadable composer (null) holds — fail closed, never paste blind", async () => {
    verdict = null;
    drive = makeDrive();
    const pending = drive.writePrompt("b1", "notice");
    expect(writes).toEqual([]);
    expect(drive.queuedCount("b1")).toBe(1);
    verdict = "empty";
    drive.onComposerClear("b1");
    await expect(pending).resolves.toBe(true);
  });

  it("non-queuing callers are refused outright while the composer is not proven empty", async () => {
    verdict = "draft";
    drive = makeDrive();
    await expect(
      drive.writePrompt("b1", "pulse", { queueIfBusy: false }),
    ).resolves.toBe(false);
    expect(writes).toEqual([]);
    expect(drive.queuedCount("b1")).toBe(0);
  });

  it("mail steering never sends Ctrl+C while the composer is not proven empty", async () => {
    idle = false;
    verdict = "draft";
    drive = makeDrive();
    const pending = drive.writePrompt("b1", "mail", { interruptIfBusy: true });
    await Promise.resolve();
    await Promise.resolve();
    // No interrupt byte — Ctrl+C would wipe the operator's draft.
    expect(writes).toEqual([]);
    idle = true;
    verdict = "empty";
    drive.onComposerClear("b1");
    await expect(pending).resolves.toBe(true);
    expect(writes.map((w) => w.data)).toEqual([
      encodeBracketedPaste("mail"),
      CR,
    ]);
  });

  it("a verdict flip between drain and paste refuses at the boundary", async () => {
    drive = makeDrive();
    const seen: string[] = [];
    const gated = new ManagedTerminalDrive({
      write: (bindingId, data) => {
        seen.push(data);
        return true;
      },
      isSeatIdle: () => true,
      // Empty at the outer gate, draft by the paste boundary: the second
      // check under the writing lock must refuse.
      composerVerdict: (() => {
        let calls = 0;
        return () => (calls++ === 0 ? "empty" : "draft");
      })(),
      stallWatch: false,
      pasteToCrSettleMs: 0,
    });
    await expect(
      gated.writePrompt("b1", "notice", { queueIfBusy: false }),
    ).resolves.toBe(false);
    expect(seen).toEqual([]);
    gated.resetForTest();
  });
});

describe("operator interlock", () => {
  const writes: Array<{ bindingId: string; data: string }> = [];
  let idle = true;
  let clock = 10_000;
  let interlock: OperatorInterlock;
  let drive: ManagedTerminalDrive;
  const attention: string[] = [];

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
      pasteToCrSettleMs: 0,
      operatorInput: interlock,
      onAttention: (_bindingId, reason) => {
        attention.push(reason);
      },
      ...over,
    });

  /** The host write path's half of the interlock, replayable from tests. */
  const operatorTypes = (bindingId: string, data: string): void => {
    interlock.noteInput(bindingId);
    interlock.holdWrite(bindingId, {
      replay: () => writes.push({ bindingId, data }),
    });
  };

  afterEach(() => {
    drive?.resetForTest();
    writes.length = 0;
    attention.length = 0;
    idle = true;
    clock = 10_000;
    vi.useRealTimers();
  });

  it("parks a keystroke inside the paste→CR span and replays it after the submit", async () => {
    interlock = new OperatorInterlock();
    // The keystroke lands while the paste write is on the wire — the modal
    // focus case. It must be held, never interleaved into the envelope.
    drive = makeDrive({
      write: (bindingId, data) => {
        writes.push({ bindingId, data });
        if (data === encodeBracketedPaste("doctrine")) {
          operatorTypes(bindingId, "h");
        }
        return true;
      },
    });
    await expect(drive.writePrompt("b1", "doctrine")).resolves.toBe(true);
    expect(writes.map((w) => w.data)).toEqual([
      encodeBracketedPaste("doctrine"),
      CR,
      "h",
    ]);
  });

  it("parks keystrokes across the settle window, not just the write gap", async () => {
    interlock = new OperatorInterlock();
    // Real settle: the keystroke arrives mid-window through the host path.
    drive = makeDrive({ pasteToCrSettleMs: 20 });
    const pending = drive.writePrompt("b1", "doctrine");
    await new Promise<void>((r) => setTimeout(r, 5));
    expect(interlock.holding("b1")).toBe(true);
    operatorTypes("b1", "x");
    expect(interlock.heldCount("b1")).toBe(1);
    await expect(pending).resolves.toBe(true);
    expect(writes.map((w) => w.data)).toEqual([
      encodeBracketedPaste("doctrine"),
      CR,
      "x",
    ]);
  });

  it("replays parked bytes onto the cleared composer after a refused CR", async () => {
    interlock = new OperatorInterlock();
    drive = makeDrive({
      pendingText: () => true,
      write: (bindingId, data) => {
        writes.push({ bindingId, data });
        if (data === CR) {
          // Operator key lands exactly as the submit CR is refused.
          operatorTypes(bindingId, "h");
          return false;
        }
        return true;
      },
    });
    await expect(drive.writePrompt("b1", "doctrine")).resolves.toBe(false);
    expect(writes.map((w) => w.data)).toEqual([
      encodeBracketedPaste("doctrine"),
      CR,
      INTERRUPT_BYTE,
      "h",
    ]);
    expect(attention).toContain("prompt-stalled");
  });

  it("refuses a non-queuing prompt while the input latch is live", async () => {
    interlock = new OperatorInterlock(() => clock);
    interlock.noteInput("b1");
    drive = makeDrive();
    await expect(
      drive.writePrompt("b1", "notice", { queueIfBusy: false }),
    ).resolves.toBe(false);
    expect(writes).toEqual([]);
  });

  it("queues during the latch and drains once the window goes quiet", async () => {
    interlock = new OperatorInterlock(() => clock);
    interlock.noteInput("b1");
    drive = makeDrive();
    const pending = drive.writePrompt("b1", "mail");
    await flushMicrotasks();
    expect(writes).toEqual([]);
    expect(drive.queuedCount("b1")).toBe(1);
    clock += OPERATOR_INPUT_LATCH_MS + 1;
    drive.onSeatIdle("b1");
    await expect(pending).resolves.toBe(true);
    expect(writes.map((w) => w.data)).toEqual([
      encodeBracketedPaste("mail"),
      CR,
    ]);
  });

  it("a resize latch gates admission the same way", async () => {
    interlock = new OperatorInterlock(() => clock);
    interlock.noteResize("b1");
    drive = makeDrive();
    await expect(
      drive.writePrompt("b1", "notice", { queueIfBusy: false }),
    ).resolves.toBe(false);
    expect(writes).toEqual([]);
  });

  it("latches are per-binding — the neighbour seat still admits", async () => {
    interlock = new OperatorInterlock(() => clock);
    interlock.noteInput("b1");
    drive = makeDrive();
    await expect(
      drive.writePrompt("b2", "other seat", { queueIfBusy: false }),
    ).resolves.toBe(true);
    expect(writes.map((w) => w.bindingId)).toEqual(["b2", "b2"]);
  });

  it("never clears a live operator draft after a stalled submit", async () => {
    interlock = new OperatorInterlock();
    drive = makeDrive({
      stallWatch: true,
      stallTimeoutMs: 30,
      // Chip stuck in the composer; the seat never publishes turn-start.
      pendingText: () => true,
    });
    const pending = drive.writePrompt("b1", "a\nb");
    await flushMicrotasks(10);
    expect(writes.map((w) => w.data)).toEqual([
      encodeBracketedPaste("a\nb"),
      CR,
      CR,
    ]);
    // Operator starts typing during the stall watch — before recovery.
    interlock.noteInput("b1");
    await expect(pending).resolves.toBe(false);
    expect(attention).toContain("prompt-stalled");
    expect(attention).toContain("operator-active");
    // No Ctrl+C to wipe their sentence.
    expect(writes.map((w) => w.data)).toEqual([
      encodeBracketedPaste("a\nb"),
      CR,
      CR,
    ]);
  });

  it("skips the recovery CR when the chip paints late and the operator is live", async () => {
    interlock = new OperatorInterlock();
    let chipPainted = false;
    drive = makeDrive({
      stallWatch: true,
      stallTimeoutMs: 30,
      pendingText: () => true,
      // Chip chrome appears only after the chip-CR check already ran — the
      // recovery CR is the next legal submit, and it must respect the latch.
      pasteChip: () => chipPainted,
    });
    const pending = drive.writePrompt("b1", "a\nb");
    setTimeout(() => {
      chipPainted = true;
      interlock.noteInput("b1");
    }, 10).unref();
    await expect(pending).resolves.toBe(false);
    expect(attention).toContain("operator-active");
    // Recipe CR only: no chip CR (chrome had not painted), no recovery CR
    // (operator live), no Ctrl+C (their draft is real).
    expect(writes.map((w) => w.data)).toEqual([
      encodeBracketedPaste("a\nb"),
      CR,
    ]);
  });

  it("refuses interrupt() while a submission span is held", async () => {
    interlock = new OperatorInterlock();
    let releasePaste!: (ok: boolean) => void;
    const gate = new Promise<boolean>((resolve) => {
      releasePaste = resolve;
    });
    drive = makeDrive({
      write: (bindingId, data) => {
        writes.push({ bindingId, data });
        return data === encodeBracketedPaste("hold me") ? gate : true;
      },
    });
    const prompt = drive.writePrompt("b1", "hold me");
    await flushMicrotasks();
    expect(interlock.holding("b1")).toBe(true);
    await expect(drive.interrupt("b1")).resolves.toBe(false);
    expect(writes.map((w) => w.data)).not.toContain(INTERRUPT_BYTE);
    releasePaste(true);
    await expect(prompt).resolves.toBe(true);
    expect(interlock.holding("b1")).toBe(false);
  });

  it("invalidateBinding drops the latch and any parked writes", async () => {
    interlock = new OperatorInterlock(() => clock);
    interlock.noteInput("b1");
    drive = makeDrive();
    drive.invalidateBinding("b1");
    expect(interlock.gateActive("b1")).toBe(false);
    // The next generation admits immediately — the dead epoch's keystroke
    // cannot shadow a replacement seat.
    await expect(
      drive.writePrompt("b1", "next gen", { queueIfBusy: false }),
    ).resolves.toBe(true);
  });
});
