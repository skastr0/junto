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
import { MailReadinessLatch } from "../../../src/main/junto/term/drive/mail-readiness";
import { InjectionSupervisor } from "../../../src/main/junto/term/injection-supervisor";
import {
  makeOnboardNudgeInterject,
  watchSeatReadiness,
} from "../../../src/main/junto/term/onboard-nudge-interject";
import type { AgentSeatStateEvent } from "../../../src/shared/agent-seat-state";
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

// ---------------------------------------------------------------------------
// The app's own path to the drive, mail readiness included.
//
// The cases above hand the supervisor the drive directly. The app does not:
// the nudge first passes mail readiness, a latch that records the first
// moment a generation's TUI is up and settled idle, and records it only when
// something looks. This is the sequence the app run lost the nudge on twice:
// a fresh seat nobody has mailed, a first message typed in its terminal.

describe("a typed first message, through the app's path (mail readiness and the gate)", () => {
  const app = (binding: string) => {
    vi.useFakeTimers({ now: 1_000_000 });
    const seat = { state: "idle" as AgentSeatStateEvent["state"], composer: "empty" as "empty" | "draft" };
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
    // Readiness exactly as ipc.ts reads it: the real latch over what the seat shows.
    const latch = new MailReadinessLatch();
    const looks: string[] = [];
    const mailReady = (bindingId: string): boolean => {
      const ready = latch.observe(bindingId, {
        running: true,
        generation: "e1",
        harness: "codex",
        seatState: seat.state,
        bracketedPaste: true,
        idleConfirmed: seat.state === "idle",
      });
      looks.push(`${seat.state}:${String(ready)}`);
      return ready;
    };
    const listeners = new Set<(event: AgentSeatStateEvent) => void>();
    const supervisor = new InjectionSupervisor();
    supervisor.setNow(() => Date.now());
    supervisor.setComposerLookup(() => seat.composer);
    const outcomes: string[] = [];
    const interject = makeOnboardNudgeInterject({ suspended: () => false, mailReady, writeMail: (b, t) => drive.writeMail(b, t) });
    supervisor.setWriter((bindingId, text) =>
      interject(bindingId, text).then((outcome) => {
        outcomes.push(outcome);
        return outcome === "written";
      }),
    );
    drive.subscribeMailWritable((bindingId) => supervisor.noteWritable(bindingId));
    // The order ipc.ts subscribes in: the supervisor first, then the watch.
    listeners.add((event) => supervisor.noteSeatState(event));
    const unwatch = watchSeatReadiness({
      subscribeSeatState: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      mailReady,
    });
    const state = (next: AgentSeatStateEvent["state"]) => {
      seat.state = next;
      const event = { bindingId: binding, epoch: "e1", state: next, reason: "test", confidence: "high" as const, at: Date.now() };
      for (const listener of [...listeners]) listener(event);
    };
    const key = (data: string) => {
      seatOperatorInterlock.noteInput(binding);
      supervisor.noteUserInput(binding, Date.now(), data);
    };
    const settle = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    };
    return { drive, seat, written, outcomes, looks, state, key, settle, unwatch };
  };

  it("a fresh seat nobody has mailed still gets the nudge within the minute, mid-turn", async () => {
    const { drive, seat, written, outcomes, state, key, settle } = app("seat-app-1");
    // The seat comes up and sits idle. No mail is pending for it, so the mail
    // layer never has a reason to look at it.
    state("idle");
    await settle(5_000);

    // The run: a first message typed in the terminal, Enter 600 ms later.
    for (const ch of "first message for learner") {
      key(ch);
      seat.composer = "draft";
      drive.onComposerDraft("seat-app-1");
      await settle(20);
    }
    await settle(600);
    key("\r");
    seat.composer = "empty";
    drive.onComposerClear("seat-app-1");
    state("working");
    // Nothing repaints and no state changes for the rest of the minute.
    await settle(60_000);

    expect(seat.state).toBe("working");
    expect(outcomes).not.toContain("unavailable");
    expect(outcomes.at(-1)).toBe("written");
    expect(written.join("").split(NUDGE).length - 1).toBe(1);
    drive.resetForTest();
  });

  it("readiness is on record from the seat's own idle moment, not from the first attempt to type", async () => {
    const { drive, looks, state, settle } = app("seat-app-2");
    state("idle");
    await settle(10);
    // Looked at when the seat was told idle, before anything wanted to type.
    expect(looks).toEqual(["idle:true"]);
    state("working");
    await settle(10);
    // So a look mid-turn answers from the record instead of failing a first look.
    expect(looks.at(-1)).toBe("working:true");
    drive.resetForTest();
  });

  it("without that watch the first look comes mid-turn, fails, and nothing ever retries: the app's lost nudge", async () => {
    const { drive, seat, written, outcomes, state, key, settle, unwatch } = app("seat-app-3");
    unwatch();
    state("idle");
    await settle(5_000);
    key("first message");
    seat.composer = "draft";
    await settle(600);
    key("\r");
    seat.composer = "empty";
    state("working");
    await settle(60_000);
    // Refused before the drive was ever asked: no hold was armed, so the
    // gate's "the box is free again" never fires for it.
    expect(outcomes).toEqual(["unavailable"]);
    expect(written.join("")).not.toContain(NUDGE);
    drive.resetForTest();
  });
});
