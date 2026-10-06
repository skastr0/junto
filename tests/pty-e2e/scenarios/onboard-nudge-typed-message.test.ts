/**
 * The onboarding nudge after a first message the operator TYPES.
 *
 * The sequence a real-app run walked and lost the nudge on: the operator
 * types a first message in the seat's terminal, presses Enter, the seat goes
 * to work, and within the next minute the nudge must be written to the seat.
 *
 * Full loop, nothing faked below the wiring: scripted TUI bytes → REAL
 * SessionObserver → REAL SeatStateRuntime composer probes → REAL
 * ManagedTerminalDrive.writeMail (the mail gate the nudge passes through) →
 * REAL InjectionSupervisor, wired the way ipc.ts wires them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  OPERATOR_INPUT_LATCH_MS,
  OperatorInterlock,
  seatOperatorInterlock,
} from "../../../src/main/junto/term/drive";
import { composerVerdictForHarness } from "../../../src/main/junto/term/agent-state";
import { createManagedTerminalDrive } from "../../../src/main/junto/term/drive/managed-drive-factory";
import { InjectionSupervisor } from "../../../src/main/junto/term/injection-supervisor";
import { SessionObserver } from "../../../src/main/junto/term/observer";
import { buildOnboardNudge } from "../../../src/shared/managed-terminal-injection";
import { DriveLoop, type DriveLoopOptions } from "../scripted-tui";

const BINDING = "seat-b1";
const NUDGE = buildOnboardNudge();

const setup = (harness: NonNullable<DriveLoopOptions["harness"]>, workingFrames: number) => {
  vi.useFakeTimers({ now: 1_000_000 });
  const operatorInput = new OperatorInterlock(() => Date.now());
  const supervisor = new InjectionSupervisor();
  supervisor.setNow(() => Date.now());
  const holder: { loop?: DriveLoop } = {};
  const loop = new DriveLoop({
    harness,
    now: () => Date.now(),
    stallTimeoutMs: 5_000,
    pasteToCrSettleMs: 40,
    tui: { workingFrames },
    onSnapshot: (snap) => supervisor.onSnapshot(snap),
    drive: {
      operatorInput,
      composerVerdict: (bindingId) => holder.loop?.runtime.composerVerdict(bindingId) ?? null,
      seatState: (bindingId) => holder.loop?.runtime.getState(bindingId),
    },
  });
  holder.loop = loop;
  // As ipc.ts wires it (wireFactorySupervisor and the drive's feeds).
  loop.runtime.subscribeComposerVerdict((bindingId, verdict) => {
    if (verdict === "empty") loop.drive.onComposerClear(bindingId);
    if (verdict === "draft") loop.drive.onComposerDraft(bindingId);
  });
  loop.runtime.subscribe((event) => supervisor.noteSeatState(event));
  supervisor.setComposerLookup((bindingId) => loop.runtime.composerVerdict(bindingId));
  const attempts: string[] = [];
  supervisor.setWriter((bindingId, text) =>
    loop.drive.writeMail(bindingId, text).then((outcome) => {
      attempts.push(outcome);
      return outcome === "written";
    }),
  );
  loop.drive.subscribeMailWritable((bindingId) => supervisor.noteWritable(bindingId));

  const flush = async () => {
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1);
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  };
  /** Operator bytes, as the terminal write IPC sends them: interlock, PTY, supervisor. */
  const operatorSends = (data: string) => {
    operatorInput.noteInput(BINDING);
    loop.tui.write(data);
    supervisor.noteUserInput(BINDING, Date.now(), data);
  };
  /**
   * The operator puts text in the composer. The scripted TUI models composer
   * text only from a paste envelope, which is also what a terminal sends for
   * pasted text.
   */
  const operatorWrites = (text: string) =>
    operatorSends(`${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`);
  /** Everything Junto itself wrote to the seat's input. */
  const typedByJunto = () => loop.writes.map((write) => write.data).join("");
  return { loop, supervisor, flush, operatorSends, operatorWrites, typedByJunto, attempts };
};

afterEach(() => {
  vi.useRealTimers();
});

// The scripted TUI paints Claude's chrome whatever harness it is told it is,
// so only its Claude form is read by real probes. Codex is covered below from
// the screen the app run showed.
describe.each(["claude"] as const)("a typed first message (%s, scripted TUI)", (harness) => {
  // These scripted TUIs paint no readable input box while they work, so the
  // gate holds the nudge as "unreadable" until the turn ends. Held is not
  // dropped: it must go out when the box is readable again, with no other
  // event to prompt it, once, and not be counted while it was held.
  it("is followed by the nudge as soon as the input box is free again", async () => {
    const { loop, supervisor, flush, operatorSends, operatorWrites, typedByJunto, attempts } = setup(harness, 5);
    await flush();
    expect(loop.runtime.getState(BINDING)).toBe("idle");

    // The message sits in the composer, then Enter sends it.
    operatorWrites("first message");
    await flush();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(typedByJunto()).not.toContain(NUDGE);
    operatorSends("\r");
    await flush();
    await vi.advanceTimersByTimeAsync(1_500);
    await flush();
    expect(loop.runtime.getState(BINDING)).toBe("working");
    // Tried at once, mid-turn, and held by the gate: nothing typed, nothing counted.
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts).not.toContain("written");
    expect(typedByJunto()).not.toContain(NUDGE);

    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(attempts.at(-1)).toBe("written");
    expect(typedByJunto().split(NUDGE).length - 1).toBe(1);
    expect(supervisor.isOnboarded(BINDING)).toBe(false);
  });

  it("counts the message when Enter comes before any draft frame is seen", async () => {
    // A fast typist, or a paste sent at once: the observer never paints the
    // draft before the turn starts.
    const { loop, flush, operatorSends, operatorWrites, typedByJunto } = setup(harness, 5);
    await flush();
    operatorWrites("first message");
    operatorSends("\r");
    await flush();
    await vi.advanceTimersByTimeAsync(1_500);
    await flush();
    expect(loop.runtime.getState(BINDING)).toBe("working");
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(typedByJunto().split(NUDGE).length - 1).toBe(1);
  });

  it("a lone Enter on a fresh seat is not a message", async () => {
    const { loop, flush, operatorSends, typedByJunto, attempts } = setup(harness, 5);
    await flush();
    operatorSends("\r");
    await flush();
    loop.tui.emitFalseWorking();
    await flush();
    loop.tui.emitIdleRestore();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(attempts).toEqual([]);
    expect(typedByJunto()).not.toContain(NUDGE);
  });
});

// ---------------------------------------------------------------------------
// The sequence the real-app run lost the nudge on (fake Codex seat).

/** The screen the run's screenshot shows while the seat works. */
const CODEX_WORKING_SCREEN = ["first message for learner", "\u2022 Working (esc to interrupt)", "", "\u203a Ask Codex to do anything"];

describe("a typed first message (codex, the screen from the app run)", () => {
  it("that working screen reads as an EMPTY input box, not an unread one", async () => {
    const observer = new SessionObserver({ bindingId: BINDING, epoch: "e1", cols: 120, rows: 32 });
    try {
      observer.feed(`\u001b[2J\u001b[H${CODEX_WORKING_SCREEN.join("\r\n")}`, 0n);
      const snapshot = await observer.snapshot();
      // So the gate has no reason to hold for the box itself: the nudge is
      // due mid-turn, and only the operator's own fresh Enter stands in its way.
      expect(composerVerdictForHarness(snapshot, "codex")).toBe("empty");
    } finally {
      observer.dispose();
    }
  });

  /**
   * The REAL drive and its mail gate under the REAL supervisor, with the seat
   * as that run had it: working, an empty readable input box, and a screen
   * that does not change again (nothing repaints, no state event follows).
   */
  const appRun = () => {
    vi.useFakeTimers({ now: 1_000_000 });
    // The drive factory binds the process's own operator interlock, the one
    // the terminal write path stamps: the same object as in the app.
    const operatorInput = seatOperatorInterlock;
    const seat = { state: "idle" as "idle" | "working", composer: "empty" as "empty" | "draft" };
    const written: string[] = [];
    const drive = createManagedTerminalDrive({
      write: (_bindingId, data) => {
        written.push(data);
        return true;
      },
      isSeatIdle: () => seat.state === "idle",
      seatState: () => seat.state,
      onAttention: () => {},
      snapshot: () => ({ text: "", lines: [] as string[] }),
      composerVerdict: () => seat.composer,
      harnessFor: () => "codex",
    });
    const supervisor = new InjectionSupervisor();
    supervisor.setNow(() => Date.now());
    supervisor.setComposerLookup(() => seat.composer);
    const attempts: string[] = [];
    supervisor.setWriter((bindingId, text) =>
      drive.writeMail(bindingId, text).then((outcome) => {
        attempts.push(outcome);
        return outcome === "written";
      }),
    );
    // The two lines production adds: operator bytes with their data, and the
    // gate's own "the box is free again".
    drive.subscribeMailWritable((bindingId) => supervisor.noteWritable(bindingId));
    const state = (next: "idle" | "working") => {
      seat.state = next;
      supervisor.noteSeatState({ bindingId: BINDING, epoch: "e1", state: next, reason: "test", confidence: "high", at: Date.now() });
    };
    const key = (data: string) => {
      operatorInput.noteInput(BINDING);
      supervisor.noteUserInput(BINDING, Date.now(), data);
    };
    const settle = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    };
    return { drive, supervisor, seat, written, attempts, state, key, settle };
  };

  it("the nudge is held by the operator's fresh Enter, then written within the minute, mid-turn, once", async () => {
    const { drive, seat, written, attempts, state, key, settle } = appRun();
    state("idle");
    await settle(10);

    // Typed a key at a time; the draft paints; Enter; the seat goes to work.
    for (const ch of "first message for learner") {
      key(ch);
      seat.composer = "draft";
      drive.onComposerDraft(BINDING);
      await settle(30);
    }
    key("\r");
    seat.composer = "empty";
    drive.onComposerClear(BINDING);
    state("working");
    await settle(60);
    // Enter was milliseconds ago: the gate reads the operator as still typing.
    expect(attempts).toEqual(["draft"]);
    expect(written.join("")).not.toContain(NUDGE);

    // Nothing else happens on the seat: no repaint, no state change.
    await settle(OPERATOR_INPUT_LATCH_MS * 5);
    expect(attempts.at(-1)).toBe("written");
    expect(written.join("")).toContain(NUDGE);

    await settle(60_000);
    expect(seat.state).toBe("working");
    expect(written.join("").split(NUDGE).length - 1).toBe(1);
    drive.resetForTest();
  });

  it("a held nudge is not one of the two: the second still comes three turns later", async () => {
    const { drive, seat, written, state, key, settle } = appRun();
    state("idle");
    await settle(10);
    key("hello there");
    seat.composer = "draft";
    key("\r");
    seat.composer = "empty";
    state("working");
    await settle(OPERATOR_INPUT_LATCH_MS * 5);
    expect(written.join("").split(NUDGE).length - 1).toBe(1);
    for (let turn = 0; turn < 3; turn += 1) {
      state("idle");
      await settle(2_000);
      state("working");
      await settle(2_000);
    }
    expect(written.join("").split(NUDGE).length - 1).toBe(2);
    drive.resetForTest();
  });
});
