/**
 * A session started by `junto offboard --continue` picks up by itself: the
 * fresh session gets exactly one line as its first message, once its composer
 * is up and empty. Nothing else starts a session with a message: not a plain
 * offboard, and not a seat the operator opens.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContinuationLedger, rotateOwing } from "../src/main/junto/seat-sessions/continuation-pending";
import {
  SeatOffboardCloser,
  type OffboardClosePorts,
} from "../src/main/junto/seat-sessions/offboard-close";
import {
  InjectionSupervisor,
  type ComposerLookup,
  type NoticeWriter,
} from "../src/main/junto/term/injection-supervisor";
import { buildOnboardNudge } from "../src/shared/managed-terminal-injection";
import type { AgentSeatStateEvent } from "../src/shared/agent-seat-state";
import { CONTINUATION_LINE, type OffboardMode } from "../src/shared/seat-sessions";

const BINDING = "bind-a";

const settled = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

/**
 * A seat, its supervisor and the real offboard closer. The closer's `close`
 * port does what rotation does to the terminal: the old generation exits and,
 * when asked to wake, a fresh one starts. `kickoff` is wired as the app wires
 * it.
 */
const rig = () => {
  const supervisor = new InjectionSupervisor();
  const typed: Array<{ epoch: string; via: "continuation" | "nudge"; text: string }> = [];
  const composer = { verdict: "empty" as ReturnType<ComposerLookup> };
  const epoch = { current: "e1" };
  supervisor.setComposerLookup(() => composer.verdict);
  supervisor.setWriter(vi.fn<NoticeWriter>((_b, text) => {
    typed.push({ epoch: epoch.current, via: "nudge", text });
    return true;
  }));
  supervisor.setContinuationWriter(vi.fn<NoticeWriter>((_b, text) => {
    typed.push({ epoch: epoch.current, via: "continuation", text });
    return true;
  }));
  const state = (value: AgentSeatStateEvent["state"], at = epoch.current) =>
    supervisor.noteSeatState({ bindingId: BINDING, epoch: at, state: value, reason: "test", confidence: "high", at: 0 });
  /** A generation comes up: starting, then idle at its own empty composer. */
  const boot = async (next: string, steps: ReadonlyArray<AgentSeatStateEvent["state"]> = ["unknown", "idle"]) => {
    epoch.current = next;
    for (const step of steps) state(step);
    await settled();
  };
  const clock = { now: 1_000 };
  const seatsRoot = mkdtempSync(join(tmpdir(), "junto-continuation-rig-"));
  roots.push(seatsRoot);
  const ledger = new ContinuationLedger(supervisor, seatsRoot, () => clock.now);
  /** What the fresh generation does as it comes up, and what happens to it meanwhile. */
  const wake = { steps: ["unknown", "idle"] as ReadonlyArray<AgentSeatStateEvent["state"]>, during: () => {} };
  const rotation = { ok: true };
  const ports: OffboardClosePorts = {
    close: async (_seat, waking) => {
      const rotate = async () => {
        if (!rotation.ok) return { ok: false as const, reason: "could not give the seat a fresh session on its canvas" };
        state("gone");
        // The fresh generation is already up when the rotation returns.
        if (waking) {
          await boot("e2", wake.steps);
          wake.during();
          await settled();
        }
        return { ok: true as const, ended: "s1", next: "s2", woke: waking };
      };
      if (!waking) return rotate();
      return rotateOwing({
        ledger,
        seatId: "a",
        bindingId: BINDING,
        offboarded: supervisor.generationOf(BINDING),
        rotate,
      });
    },
    kickoff: async () => true,
    publish: () => {},
    now: () => clock.now,
  };
  const closer = new SeatOffboardCloser(ports);
  /** The agent runs `junto offboard`; the closer ends its session at once. */
  const offboard = async (mode: OffboardMode) => {
    await closer.offboarded({ seatId: "a", canvasName: "c", sessionId: "s1", at: clock.now, mode });
    await settled();
  };
  const turn = () => {
    state("working");
    state("idle");
  };
  return { supervisor, typed, composer, epoch, state, boot, offboard, turn, wake, rotation };
};

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("continuing after junto offboard --continue", () => {
  it("delivers the line once into the fresh generation, and nothing else", async () => {
    const { supervisor, typed, boot, offboard, turn } = rig();
    await boot("e1");
    await offboard("continue");
    expect(typed).toEqual([{ epoch: "e2", via: "continuation", text: CONTINUATION_LINE }]);
    expect(supervisor.continuationPending(BINDING)).toBe(false);
    // The agent reads its handoff and carries on: nothing more is typed.
    supervisor.noteOnboarded(BINDING);
    for (let i = 0; i < 8; i += 1) turn();
    expect(typed).toHaveLength(1);
  });

  it("is one line", () => {
    expect(CONTINUATION_LINE).toBe(
      "Continuing from your previous session. Run `junto onboard` to read your handoff.",
    );
    expect(CONTINUATION_LINE).not.toContain("\n");
  });

  it("never reaches the generation that offboarded", async () => {
    const { supervisor, typed, boot, state } = rig();
    await boot("e1");
    // The old process is still up, idle at an empty composer, when the
    // continuation is asked for.
    supervisor.armContinuation(BINDING, supervisor.generationOf(BINDING));
    state("idle");
    await settled();
    expect(typed).toEqual([]);
    state("gone");
    await boot("e2");
    expect(typed).toEqual([{ epoch: "e2", via: "continuation", text: CONTINUATION_LINE }]);
  });

  it("waits for the composer: never on a dialog, never before the box is readable and empty", async () => {
    const { supervisor, typed, composer, boot, state } = rig();
    await boot("e1");
    state("gone");
    supervisor.armContinuation(BINDING, "e1");
    // The fresh harness opens on a folder-trust dialog.
    composer.verdict = null;
    await boot("e2", ["unknown", "attention"]);
    expect(typed).toEqual([]);
    // Answered; the TUI is still painting.
    state("idle");
    expect(typed).toEqual([]);
    composer.verdict = "draft";
    supervisor.onSnapshot({ bindingId: BINDING, epoch: "e2" } as never);
    expect(typed).toEqual([]);
    composer.verdict = "empty";
    supervisor.onSnapshot({ bindingId: BINDING, epoch: "e2" } as never);
    expect(typed).toEqual([{ epoch: "e2", via: "continuation", text: CONTINUATION_LINE }]);
  });

  it("waits for a seat that did not start, and reaches it when it does", async () => {
    // A paused canvas: the session is rotated but nothing wakes the seat.
    const { supervisor, typed, boot, state } = rig();
    await boot("e1");
    state("gone");
    supervisor.armContinuation(BINDING, "e1");
    await settled();
    expect(typed).toEqual([]);
    expect(supervisor.continuationPending(BINDING)).toBe(true);
    await boot("e2");
    expect(typed).toEqual([{ epoch: "e2", via: "continuation", text: CONTINUATION_LINE }]);
  });

  it("a line the drive refused is tried again, and typed only once", async () => {
    const { supervisor, typed, boot, state } = rig();
    const writer = vi.fn<NoticeWriter>().mockReturnValueOnce(false).mockReturnValue(true);
    supervisor.setContinuationWriter(writer);
    await boot("e1");
    state("gone");
    supervisor.armContinuation(BINDING, "e1");
    await boot("e2");
    expect(writer).toHaveBeenCalledTimes(1);
    supervisor.onSnapshot({ bindingId: BINDING, epoch: "e2" } as never);
    expect(writer).toHaveBeenCalledTimes(2);
    supervisor.onSnapshot({ bindingId: BINDING, epoch: "e2" } as never);
    state("working");
    state("idle");
    expect(writer).toHaveBeenCalledTimes(2);
    expect(typed).toEqual([]);
  });

  it("counts as the session's first message: the nudge policy applies from there", async () => {
    const { typed, boot, offboard, state, turn } = rig();
    await boot("e1");
    await offboard("continue");
    // The line's own turn runs and ends without the agent onboarding.
    turn();
    expect(typed).toHaveLength(1);
    // The next turn that starts earns the first nudge, mid-turn.
    state("working");
    expect(typed.slice(1)).toEqual([{ epoch: "e2", via: "nudge", text: buildOnboardNudge() }]);
  });
});

describe("the line is owed before the fresh session exists, and is never given up on", () => {
  // The app, three seats continuing in the same half second: one fresh
  // session came up to a clean empty prompt and was never told (SB g1).
  it("a line refused at the fresh session's only idle moment is typed without waiting for another event", async () => {
    vi.useFakeTimers();
    const { supervisor, typed, boot, offboard } = rig();
    let ready = false;
    supervisor.setContinuationWriter((_b, text) => {
      if (ready) typed.push({ epoch: "e2", via: "continuation", text });
      return ready;
    });
    await boot("e1");
    await offboard("continue");
    expect(typed).toEqual([]);
    // The terminal can take it a moment later. The seat sits idle at its
    // empty prompt: no state event and no new screen will ever come.
    ready = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(typed).toEqual([{ epoch: "e2", via: "continuation", text: CONTINUATION_LINE }]);
    expect(supervisor.continuationPending(BINDING)).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(typed).toHaveLength(1);
  });

  // The operator typed in the open terminal in the moment after the
  // offboard: the write was held for their keystrokes and never retried
  // (SJ3-keys-continue).
  it("held while the operator types, it is typed once they stop", async () => {
    vi.useFakeTimers();
    const { supervisor, typed, boot, offboard, wake } = rig();
    let operatorTyping = true;
    supervisor.setContinuationWriter((_b, text) => {
      if (!operatorTyping) typed.push({ epoch: "e2", via: "continuation", text });
      return !operatorTyping;
    });
    wake.during = () => supervisor.noteUserInput(BINDING, 1_000, "hijack-keys-one");
    await boot("e1");
    await offboard("continue");
    expect(typed).toEqual([]);
    operatorTyping = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(typed).toEqual([{ epoch: "e2", via: "continuation", text: CONTINUATION_LINE }]);
  });

  // The operator's prompt reached the fresh session first and started its
  // turn: the session got the onboarding nudge and never its line
  // (SJ2-prompt-continue).
  it("a prompt that reaches the fresh session first does not cost it the line, and it is not nudged", async () => {
    const { supervisor, typed, boot, offboard, wake, state } = rig();
    // Queued while the seat was down, the prompt is typed the instant the
    // fresh session is up, before it was ever seen idle; its turn starts.
    wake.steps = ["unknown"];
    wake.during = () => {
      supervisor.noteMailWritten(BINDING);
      state("working");
    };
    await boot("e1");
    await offboard("continue");
    // Mid-turn, like mail: the turn may run for hours.
    expect(typed).toEqual([{ epoch: "e2", via: "continuation", text: CONTINUATION_LINE }]);
    // A second prompt in the same turn, and the turn's end: still no nudge.
    supervisor.noteMailWritten(BINDING);
    state("idle");
    expect(typed).toHaveLength(1);
  });

  it("a record that cannot be read yet is asked again without waiting for an event", async () => {
    vi.useFakeTimers();
    const { supervisor, typed, boot, offboard } = rig();
    let readable = false;
    supervisor.setOnboardedRecord({
      load: async () => (readable ? false : undefined),
      save: async () => true,
    });
    await boot("e1");
    await offboard("continue");
    expect(typed).toEqual([]);
    readable = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(typed).toEqual([{ epoch: "e2", via: "continuation", text: CONTINUATION_LINE }]);
  });

  it("says in the log why the line is waiting, once per reason, and when it stops", async () => {
    vi.useFakeTimers();
    const { supervisor, composer, boot, offboard } = rig();
    const log: string[] = [];
    supervisor.setContinuationLog((message) => log.push(message));
    let ready = false;
    supervisor.setContinuationWriter(() => ready);
    await boot("e1");
    composer.verdict = "draft";
    await offboard("continue");
    await vi.advanceTimersByTimeAsync(5_000);
    composer.verdict = "empty";
    await vi.advanceTimersByTimeAsync(5_000);
    ready = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(log).toEqual([
      "bind-a: the continuation line is waiting: its input box cannot take it (seat unknown, box draft)",
      "bind-a: the continuation line is waiting: its input box cannot take it (seat idle, box draft)",
      "bind-a: the continuation line is waiting: the terminal refused it (seat idle, box empty)",
      "bind-a: the continuation line is no longer waiting",
    ]);
  });

  it("is owed from before the old process goes, so nothing can get in ahead of it", async () => {
    const { supervisor, boot, offboard, wake } = rig();
    const pendingAsFreshCameUp: boolean[] = [];
    wake.during = () => pendingAsFreshCameUp.push(supervisor.continuationPending(BINDING));
    wake.steps = ["unknown"];
    await boot("e1");
    await offboard("continue");
    expect(pendingAsFreshCameUp).toEqual([true]);
  });

  it("a close that could not give the seat a fresh session owes nothing", async () => {
    const { supervisor, typed, boot, offboard, rotation, turn } = rig();
    rotation.ok = false;
    await boot("e1");
    await offboard("continue");
    expect(supervisor.continuationPending(BINDING)).toBe(false);
    // The old session goes on; it is never told to continue.
    for (let i = 0; i < 3; i += 1) turn();
    expect(typed.filter((entry) => entry.via === "continuation")).toEqual([]);
  });
});

describe("nothing else starts a session with a message", () => {
  it("a plain offboard lets the seat rest and types nothing, then or at its next wake", async () => {
    const { supervisor, typed, boot, offboard } = rig();
    await boot("e1");
    await offboard("rest");
    expect(supervisor.continuationPending(BINDING)).toBe(false);
    // Mail wakes it later: the fresh session comes up to an empty composer.
    await boot("e2");
    expect(typed).toEqual([]);
  });

  it("a fresh seat the operator opens is told nothing", async () => {
    const { supervisor, typed, boot, turn } = rig();
    await boot("e1");
    supervisor.onSnapshot({ bindingId: BINDING, epoch: "e1" } as never);
    // Whatever the harness does while it starts up.
    for (let i = 0; i < 4; i += 1) turn();
    expect(typed).toEqual([]);
  });

  it("the continuation has one way in: the offboard closer's close, when the seat continues", () => {
    const root = fileURLToPath(new URL("../src", import.meta.url));
    const sources: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name)) sources.push(path);
      }
    };
    walk(root);
    const callersOf = (pattern: RegExp) =>
      sources.flatMap((path) => {
        const text = readFileSync(path, "utf8");
        return [...text.matchAll(pattern)].map((match) => ({
          file: path.slice(root.length + 1),
          before: text.slice(Math.max(0, match.index - 500), match.index),
        }));
      });
    // The supervisor is armed by the ledger alone: when a continuation is
    // owed, and again for what a previous run recorded and never delivered.
    expect(new Set(callersOf(/\.armContinuation\(/g).map((caller) => caller.file))).toEqual(
      new Set(["main/junto/seat-sessions/continuation-pending.ts"]),
    );
    // A continuation becomes owed in exactly one place: the closer's close
    // port, for a rotation asked to wake, before that rotation starts.
    expect(callersOf(/\.owe\(/g).map((caller) => caller.file)).toEqual([
      "main/junto/seat-sessions/continuation-pending.ts",
    ]);
    const owing = callersOf(/\browing: *|\brotateOwing\(\{/g);
    expect(owing.map((caller) => caller.file)).toEqual(["main/junto/ipc.ts"]);
    expect(owing[0]?.before).toMatch(/const seat = wake \? await managedSeatOn\(address\) : undefined;/);
    expect(callersOf(/\bnew ContinuationLedger\(/g).map((caller) => caller.file)).toEqual(["main/junto/ipc.ts"]);
    // And the line itself is typed from one place.
    const users = sources
      .filter((path) => /\bCONTINUATION_LINE\b/.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(root.length + 1))
      .sort();
    expect(users).toEqual(["main/junto/term/injection-supervisor.ts", "shared/seat-sessions.ts"]);
  });
});

describe("a continuation owed across a restart", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** One run of the app: a supervisor and a ledger over the same seats root. */
  const run = (seatsRoot: string) => {
    const supervisor = new InjectionSupervisor();
    const typed: string[] = [];
    supervisor.setContinuationWriter((_b, text) => {
      typed.push(text);
      return true;
    });
    supervisor.setWriter(() => true);
    const ledger = new ContinuationLedger(supervisor, seatsRoot);
    const boot = async (epoch: string) => {
      for (const state of ["unknown", "idle"] as const) {
        supervisor.noteSeatState({ bindingId: BINDING, epoch, state, reason: "test", confidence: "high", at: 0 });
      }
      await settled();
    };
    return { supervisor, ledger, typed, boot };
  };

  const pendingFile = (seatsRoot: string) => join(seatsRoot, "seat-a", "continuation.pending");

  it("survives Junto quitting before the seat ever started", async () => {
    dir = mkdtempSync(join(tmpdir(), "junto-continuation-"));
    // Run 1: the seat offboards with --continue on a paused canvas. The
    // session is rotated, nothing wakes the seat, and Junto quits.
    const first = run(dir);
    first.ledger.owe("seat-a", BINDING, "e1");
    expect(first.supervisor.continuationPending(BINDING)).toBe(true);
    expect(first.typed).toEqual([]);
    expect(existsSync(pendingFile(dir))).toBe(true);

    // Run 2: a new process with nothing in memory.
    const second = run(dir);
    expect(second.supervisor.continuationPending(BINDING)).toBe(false);
    expect(second.ledger.restore()).toBe(1);
    expect(second.supervisor.continuationPending(BINDING)).toBe(true);
    // The canvas plays and the fresh session comes up.
    await second.boot("e2");
    expect(second.typed).toEqual([CONTINUATION_LINE]);
    expect(existsSync(pendingFile(dir))).toBe(false);

    // Run 3: delivered means delivered. Nothing is owed any more.
    const third = run(dir);
    expect(third.ledger.restore()).toBe(0);
    await third.boot("e3");
    expect(third.typed).toEqual([]);
  });

  it("is still owed after a restart that ends before the seat starts again", async () => {
    dir = mkdtempSync(join(tmpdir(), "junto-continuation-"));
    run(dir).ledger.owe("seat-a", BINDING, "e1");
    const second = run(dir);
    expect(second.ledger.restore()).toBe(1);
    const third = run(dir);
    expect(third.ledger.restore()).toBe(1);
    await third.boot("e2");
    expect(third.typed).toEqual([CONTINUATION_LINE]);
  });

  it("a restart never tells the generation that offboarded", async () => {
    dir = mkdtempSync(join(tmpdir(), "junto-continuation-"));
    run(dir).ledger.owe("seat-a", BINDING, "e1");
    const second = run(dir);
    second.ledger.restore();
    await second.boot("e1");
    expect(second.typed).toEqual([]);
    expect(existsSync(pendingFile(dir))).toBe(true);
  });

  it("a session that onboards on its own is owed nothing", async () => {
    dir = mkdtempSync(join(tmpdir(), "junto-continuation-"));
    const first = run(dir);
    first.ledger.owe("seat-a", BINDING, "e1");
    first.supervisor.noteOnboarded(BINDING);
    await first.boot("e2");
    expect(first.typed).toEqual([]);
    expect(existsSync(pendingFile(dir))).toBe(false);
  });

  it("restores nothing from a run that owed nothing, and drops a file it cannot read", () => {
    dir = mkdtempSync(join(tmpdir(), "junto-continuation-"));
    expect(run(dir).ledger.restore()).toBe(0);
    mkdirSync(join(dir, "seat-a"), { recursive: true });
    writeFileSync(pendingFile(dir), "not json");
    const next = run(dir);
    expect(next.ledger.restore()).toBe(0);
    expect(next.supervisor.continuationPending(BINDING)).toBe(false);
    expect(existsSync(pendingFile(dir))).toBe(false);
  });
});
