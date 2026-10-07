/**
 * The continuation line when the operator's prompt reaches the fresh session
 * first (app walk SJ2-prompt-continue).
 *
 * The operator sends two prompts from the seat composer in the moment after
 * `junto offboard --continue`. They are queued while the seat is down and
 * typed as mail the moment the fresh session is up. The line must still be
 * typed, once, with no nudge before it.
 *
 * Real loop: scripted TUI bytes, the real observer, seat-state runtime,
 * drive mail gate, mail readiness latch and supervisor, wired as ipc.ts
 * wires them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperatorInterlock } from "../../../src/main/junto/term/drive";
import { MailReadinessLatch } from "../../../src/main/junto/term/drive/mail-readiness";
import { InjectionSupervisor } from "../../../src/main/junto/term/injection-supervisor";
import { makeOnboardNudgeInterject, watchSeatReadiness } from "../../../src/main/junto/term/onboard-nudge-interject";
import { buildOnboardNudge } from "../../../src/shared/managed-terminal-injection";
import { CONTINUATION_LINE } from "../../../src/shared/seat-sessions";
import { DriveLoop } from "../scripted-tui";

const BINDING = "seat-b1";

const setup = (workingFrames: number, options: { readonly lineFirst: boolean }) => {
  vi.useFakeTimers({ now: 1_000_000 });
  const supervisor = new InjectionSupervisor();
  supervisor.setNow(() => Date.now());
  const log: string[] = [];
  supervisor.setContinuationLog((message) => log.push(message));
  // Owed before the fresh session exists, naming the generation that offboarded.
  supervisor.armContinuation(BINDING, "the-generation-that-offboarded");
  const holder: { loop?: DriveLoop } = {};
  const loop = new DriveLoop({
    harness: "claude",
    now: () => Date.now(),
    stallTimeoutMs: 5_000,
    pasteToCrSettleMs: 40,
    tui: { workingFrames },
    onSnapshot: (snap) => supervisor.onSnapshot(snap),
    drive: {
      operatorInput: new OperatorInterlock(() => Date.now()),
      composerVerdict: (bindingId) => holder.loop?.runtime.composerVerdict(bindingId) ?? null,
      seatState: (bindingId) => holder.loop?.runtime.getState(bindingId),
    },
  });
  holder.loop = loop;
  loop.runtime.subscribeComposerVerdict((bindingId, verdict) => {
    if (verdict === "empty") loop.drive.onComposerClear(bindingId);
    if (verdict === "draft") loop.drive.onComposerDraft(bindingId);
  });
  const latch = new MailReadinessLatch();
  const mailReady = (bindingId: string): boolean => {
    const snap = loop.observer.snapshotNow();
    return latch.observe(bindingId, {
      running: true,
      generation: snap.epoch,
      harness: "claude",
      seatState: loop.runtime.getState(bindingId),
      bracketedPaste: snap.signals.modes.bracketedPaste === true,
      idleConfirmed: loop.runtime.isSeatIdle(bindingId),
      lines: snap.lines,
    });
  };
  // Subscription order as in ipc.ts: readiness is watched, then the supervisor hears.
  watchSeatReadiness({ subscribeSeatState: (listener) => loop.runtime.subscribe(listener), mailReady });
  // Mail delivery hears the seat come up before the supervisor does, as in
  // the app: the operator's queued prompts are typed at the first ready moment.
  const pending = ["mail from operator\nhijack-prompt-one", "mail from operator\nhijack-prompt-two"];
  const delivered: string[] = [];
  let pumping = false;
  const pump = (): void => {
    if (pumping || pending.length === 0) return;
    pumping = true;
    void deliverMail(pending[0]!).then((outcome) => {
      pumping = false;
      if (outcome !== "written") return;
      delivered.push(pending.shift()!);
      pump();
    });
  };
  loop.runtime.subscribe(() => pump());
  loop.runtime.subscribe((event) => supervisor.noteSeatState(event));
  supervisor.setComposerLookup((bindingId) => loop.runtime.composerVerdict(bindingId));
  const outcomes: string[] = [];
  const interject = makeOnboardNudgeInterject({
    suspended: () => false,
    mailReady,
    writeMail: (bindingId, text) => loop.drive.writeMail(bindingId, text),
  });
  const writer = (bindingId: string, text: string) =>
    interject(bindingId, text).then((outcome) => {
      outcomes.push(`${text === CONTINUATION_LINE ? "line" : "nudge"}:${outcome}`);
      return outcome === "written";
    });
  supervisor.setWriter(writer);
  supervisor.setContinuationWriter(writer);
  loop.drive.subscribeMailWritable((bindingId) => supervisor.noteWritable(bindingId));

  /** Mail delivery, as message-delivery does it: typed when the seat is ready, then noted. */
  const deliverMail = async (text: string): Promise<string> => {
    if (!mailReady(BINDING)) return "not-ready";
    // seatLive, as ipc.ts answers it for mail.
    if (options.lineFirst && supervisor.continuationHoldsMail(BINDING)) return "line-first";
    const outcome = await loop.drive.writeMail(BINDING, text);
    if (outcome === "written") supervisor.noteMailWritten(BINDING);
    return outcome;
  };
  const flush = async () => {
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1);
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  };
  const typedByJunto = () => loop.writes.map((write) => write.data).join("");
  if (options.lineFirst) supervisor.subscribeContinuationCleared(() => pump());
  return { loop, supervisor, flush, pump, pending, delivered, typedByJunto, outcomes, log };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("the continuation line, when the operator's prompts are queued for the fresh session", () => {
  const run = async (lineFirst: boolean) => {
    // A long turn: this TUI paints no readable input box while it works.
    const rig = setup(400, { lineFirst });
    await rig.flush();
    for (let i = 0; i < 40; i += 1) {
      rig.pump();
      await vi.advanceTimersByTimeAsync(300);
      await rig.flush();
    }
    const typed = rig.typedByJunto();
    return {
      order: [CONTINUATION_LINE, "hijack-prompt-one", "hijack-prompt-two", buildOnboardNudge()]
        .map((text, index) => ({ what: ["line", "prompt one", "prompt two", "nudge"][index]!, at: typed.indexOf(text) }))
        .filter((entry) => entry.at !== -1)
        .sort((a, b) => a.at - b.at)
        .map((entry) => entry.what),
      log: rig.log,
    };
  };

  // What the app walk showed: both prompts typed, the line never, for the
  // whole of the turn they started.
  it("without the line going first, the prompts start a turn that keeps the line out", async () => {
    const { order } = await run(false);
    expect(order[0]).toBe("prompt one");
    expect(order).not.toContain("line");
    expect(order).not.toContain("nudge");
  });

  it("the line is typed first, then the prompts, and no nudge", async () => {
    const { order } = await run(true);
    expect(order[0]).toBe("line");
    expect(order).toContain("prompt one");
    expect(order).not.toContain("nudge");
  });
});
