/**
 * Mail typed into a seat is counted against turns started on it. Mail is
 * stamped delivered when the drive finishes typing; this is what shows a
 * stamped mail that never started a turn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManagedTerminalDrive } from "../src/core/term/drive";
import {
  MAIL_TURN_START_BOUND_MS,
  MailTurnWatch,
  type MailTurnMiss,
} from "../src/core/term/drive/mail-turn-watch";

const BOUND = 1_000;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const SCREEN = { chipOnScreen: false, textOnScreen: false };

describe("MailTurnWatch", () => {
  beforeEach(() => vi.useFakeTimers());

  const rig = () => {
    const misses: MailTurnMiss[] = [];
    const watch = new MailTurnWatch({
      boundMs: BOUND,
      now: () => Date.now(),
      onMiss: (miss) => misses.push(miss),
    });
    return { watch, misses };
  };

  it("counts a turn that starts inside the bound and records no miss", () => {
    const { watch, misses } = rig();
    const handle = watch.open("s", { expectTurn: true, text: "a\nb" });
    watch.arm(handle, () => SCREEN);
    vi.advanceTimersByTime(BOUND - 1);
    watch.turnStarted("s");
    vi.advanceTimersByTime(BOUND * 5);
    expect(watch.stats("s")).toEqual({ written: 1, expected: 1, started: 1, missed: 0, late: 0 });
    expect(misses).toEqual([]);
  });

  it("sees a turn start that lands before the write resolves", () => {
    const { watch, misses } = rig();
    const handle = watch.open("s", { expectTurn: true, text: "x" });
    watch.turnStarted("s");
    watch.arm(handle, () => SCREEN);
    vi.advanceTimersByTime(BOUND * 5);
    expect(watch.stats("s")).toMatchObject({ written: 1, expected: 1, started: 1, missed: 0 });
    expect(misses).toEqual([]);
  });

  it("records a miss with what the screen showed, never the text", () => {
    const { watch, misses } = rig();
    const t0 = Date.now();
    watch.arm(watch.open("s", { expectTurn: true, text: "secret\nbody" }), () => ({
      chipOnScreen: true,
      textOnScreen: true,
    }));
    vi.advanceTimersByTime(BOUND);
    expect(misses).toEqual([
      { bindingId: "s", writtenAt: t0, boundMs: BOUND, chars: 11, lines: 2, chipOnScreen: true, textOnScreen: true },
    ]);
    expect(JSON.stringify(misses)).not.toContain("secret");
    expect(watch.stats("s")).toEqual({ written: 1, expected: 1, started: 0, missed: 1, late: 0 });
  });

  it("marks a miss late when the turn starts after the bound", () => {
    const { watch } = rig();
    watch.arm(watch.open("s", { expectTurn: true, text: "x" }), () => SCREEN);
    vi.advanceTimersByTime(BOUND + 400);
    watch.turnStarted("s");
    expect(watch.misses("s")[0]?.lateAfterMs).toBe(BOUND + 400);
    expect(watch.stats("s")).toEqual({ written: 1, expected: 1, started: 0, missed: 1, late: 1 });
  });

  it("counts mail typed into a working seat as written and never owes it a turn", () => {
    const { watch, misses } = rig();
    watch.arm(watch.open("s", { expectTurn: false, text: "steer" }), () => SCREEN);
    vi.advanceTimersByTime(BOUND * 5);
    expect(watch.stats("s")).toEqual({ written: 1, expected: 0, started: 0, missed: 0, late: 0 });
    expect(misses).toEqual([]);
  });

  it("owes nothing for a write that was discarded or a seat that was replaced", () => {
    const { watch, misses } = rig();
    watch.discard(watch.open("s", { expectTurn: true, text: "x" }));
    watch.arm(watch.open("t", { expectTurn: true, text: "x" }), () => SCREEN);
    watch.forget("t");
    vi.advanceTimersByTime(BOUND * 5);
    expect(watch.stats("s").written).toBe(0);
    expect(watch.stats("t").missed).toBe(0);
    expect(misses).toEqual([]);
  });

  it("keeps seats apart and sums them", () => {
    const { watch } = rig();
    for (const id of ["a", "b", "c"]) watch.arm(watch.open(id, { expectTurn: true, text: "x" }), () => SCREEN);
    watch.turnStarted("a");
    vi.advanceTimersByTime(BOUND);
    expect(watch.allStats().total).toEqual({ written: 3, expected: 3, started: 1, missed: 2, late: 0 });
    expect(watch.misses().map((miss) => miss.bindingId)).toEqual(["b", "c"]);
  });
});

describe("the drive's mail path", () => {
  const rig = (screen: { chip: boolean }) => {
    const writes: string[] = [];
    let idle = true;
    let startTurn: ((bindingId: string) => void) | undefined;
    const drive: ManagedTerminalDrive = new ManagedTerminalDrive({
      write: (bindingId, data) => {
        writes.push(data);
        if (data === "\r") startTurn?.(bindingId);
        return true;
      },
      isSeatIdle: () => idle,
      pasteToCrSettleMs: 0,
      mailTurnBoundMs: 30,
      pasteChip: () => screen.chip,
    });
    return {
      drive,
      writes,
      setIdle: (value: boolean) => (idle = value),
      onEnter: (fn: (bindingId: string) => void) => (startTurn = fn),
    };
  };
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("counts delivered mail whose turn started", async () => {
    const { drive, onEnter } = rig({ chip: false });
    onEnter((bindingId) => drive.onTurnStart(bindingId));
    await expect(drive.writeMail("b", "one\ntwo")).resolves.toBe("written");
    await wait(60);
    expect(drive.mailTurnStats("b")).toEqual({ written: 1, expected: 1, started: 1, missed: 0, late: 0 });
    expect(drive.mailTurnMisses()).toEqual([]);
  });

  it("records mail stamped written whose turn never started", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { drive } = rig({ chip: true });
    await expect(drive.writeMail("b", "secret\nbody")).resolves.toBe("written");
    await wait(60);
    expect(drive.mailTurnStats("b")).toEqual({ written: 1, expected: 1, started: 0, missed: 1, late: 0 });
    expect(drive.mailTurnMisses("b")).toMatchObject([{ bindingId: "b", lines: 2, chipOnScreen: true }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("no turn started within 30 ms");
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("secret");
  });

  it("does not owe a turn for mail typed into a working seat", async () => {
    const { drive, setIdle } = rig({ chip: false });
    setIdle(false);
    await expect(drive.writeMail("b", "steer")).resolves.toBe("written");
    await wait(60);
    expect(drive.mailTurnStats("b")).toEqual({ written: 1, expected: 0, started: 0, missed: 0, late: 0 });
  });

  it("sums many seats prompted at once", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { drive, onEnter } = rig({ chip: false });
    // Seats 0 to 6 start a turn; seats 7 to 9 swallow the Enter.
    onEnter((bindingId) => {
      if (Number(bindingId.slice(1)) < 7) drive.onTurnStart(bindingId);
    });
    const ids = Array.from({ length: 10 }, (_, index) => `s${index}`);
    await Promise.all(ids.map((id) => drive.writeMail(id, "a\nb")));
    await wait(60);
    expect(drive.mailTurnStats()).toEqual({ written: 10, expected: 10, started: 7, missed: 3, late: 0 });
    expect(drive.mailTurnMisses().map((miss) => miss.bindingId).sort()).toEqual(["s7", "s8", "s9"]);
  });

  it("uses a bound of ten seconds unless told otherwise", () => {
    expect(MAIL_TURN_START_BOUND_MS).toBe(10_000);
  });
});
