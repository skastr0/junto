import { describe, expect, it } from "vitest";
import { SeatStateRuntime } from "../../../src/main/junto/term/agent-state/runtime";
import { createManagedTerminalDrive } from "../../../src/main/junto/term/drive/managed-drive-factory";
import { promptStillPending } from "../../../src/main/junto/term/drive/prompt-evidence";
import { isManagedTerminalReady } from "../../../src/main/junto/term/drive/readiness";
import { DEFAULT_PROMPT_STALL_MS } from "../../../src/main/junto/term/drive/typing";
import { SessionObserver } from "../../../src/main/junto/term/observer";
import type { ObserverGridSnapshot } from "../../../src/main/junto/term/observer/types";
import { CHUNK_MODES, chunkBytes, gateFixture, requireCapture, type ChunkMode } from "../runner";

const FRAME_END = "\x1b[?2026l";
const SPINNER = /[\u2800-\u28ff]/u;
const PROBE = "review probe";
const paste = (text: string): string => `\x1b[200~${text}\x1b[201~`;

/** Each file supplies its own recorded initialization, with no other fixture prepended. */
const recorded = (scenario: string) => {
  const fixture = requireCapture("amp", scenario);
  expect(fixture.source).toBe("P1");
  const bytes = Buffer.concat(fixture.events.map((event) => Buffer.from(event.b64, "base64"))).toString("utf8");
  const frames: string[] = [];
  let start = 0;
  let end: number;
  while ((end = bytes.indexOf(FRAME_END, start)) !== -1) {
    end += FRAME_END.length;
    frames.push(bytes.slice(start, end));
    start = end;
  }
  expect(frames.length, `amp/${scenario} has no captured synchronized renders`).toBeGreaterThan(0);
  // Retain trailing OSC/cursor bytes in the final render rather than dropping
  // them or taking snapshots inside arbitrary transport chunks.
  if (start < bytes.length) frames[frames.length - 1] += bytes.slice(start);
  return { fixture, frames };
};

const hasEmptyBox = (snapshot: ObserverGridSnapshot): boolean => {
  const lines = snapshot.lines.filter((line) => line.trim()).slice(-8);
  return lines.some((line) => /^\s*╭─/u.test(line)) &&
    lines.some((line) => /^\s*│\s*│\s*$/u.test(line));
};

type Frame = {
  readonly snapshot: ObserverGridSnapshot;
  readonly state: ReturnType<SeatStateRuntime["getState"]>;
  readonly composer: ReturnType<SeatStateRuntime["composerVerdict"]>;
  readonly idle: boolean;
  readonly ready: boolean;
  readonly reason: string;
  readonly index: number;
};

const receipt = (frame: Frame): string => JSON.stringify({
  index: frame.index,
  title: frame.snapshot.signals.title,
  state: frame.state,
  composer: frame.composer,
  idle: frame.idle,
  ready: frame.ready,
  reason: frame.reason,
  footer: frame.snapshot.lines.filter((line) => line.trim()).slice(-8),
});

const replay = (scenario: string, mode: ChunkMode, acknowledgeText?: string) => {
  const bindingId = `amp-${scenario}-${mode}`;
  const epoch = "recorded-epoch";
  const observer = new SessionObserver({ bindingId, epoch, cols: 120, rows: 32 });
  const runtime = new SeatStateRuntime({ now: () => 1_000_000, turnProgressWatch: false });
  const writes: string[] = [];
  const attention: string[] = [];
  const acknowledgements: Array<{ afterCr: boolean; pending: boolean }> = [];
  let currentSnapshot: ObserverGridSnapshot | undefined;
  let seq = 0n;
  let index = 0;
  let writeOutput: ((data: string) => Promise<void>) | undefined;
  const drive = createManagedTerminalDrive({
    write: async (_id, data) => {
      writes.push(data);
      await writeOutput?.(data);
      return true;
    },
    isSeatIdle: (id) => runtime.isSeatIdle(id),
    seatState: (id) => runtime.getState(id),
    onAttention: (_id, reason) => attention.push(reason),
    snapshot: () => currentSnapshot,
    composerVerdict: (id) => runtime.composerVerdict(id),
    harnessFor: () => "amp",
  });
  runtime.bindHarness(bindingId, "amp", epoch);

  return {
    bindingId, drive, writes, attention, acknowledgements,
    setWriteOutput(callback: (data: string) => Promise<void>) { writeOutput = callback; },
    async feed(bytes: string): Promise<Frame> {
      for (const chunk of chunkBytes(bytes, mode)) observer.feed(chunk, ++seq);
      const snapshot = await observer.snapshot();
      // The shared drive must see this grid when the runtime publishes its event.
      currentSnapshot = snapshot;
      const event = runtime.observe(snapshot);
      const current: Frame = {
        snapshot,
        state: runtime.getState(bindingId),
        composer: runtime.composerVerdict(bindingId),
        idle: runtime.isSeatIdle(bindingId),
        ready: isManagedTerminalReady({ harness: "amp", seatState: runtime.getState(bindingId), snapshot }),
        reason: runtime.machine.getSlot(bindingId)?.reason ?? "unbound",
        index: index++,
      };
      if (acknowledgeText !== undefined && event?.state === "working") {
        acknowledgements.push({ afterCr: writes.includes("\r"), pending: promptStillPending(snapshot, acknowledgeText) });
        drive.onTurnStart(bindingId);
      }
      if (acknowledgeText !== undefined && event?.state === "idle") drive.onSeatIdle(bindingId);
      return current;
    },
    async assertAdmission(
      frame: Frame,
      expected: "admitted" | "not-ready" | "seat-busy" | "composer-not-empty",
    ): Promise<void> {
      writes.length = 0;
      const result = await drive.writePrompt(bindingId, PROBE, {
        queueIfBusy: false,
        awaitTurnStart: false,
        ready: frame.ready,
      });
      const admitted = expected === "admitted";
      // This call supplies recorded readiness explicitly. A false readiness
      // input refuses before the seat/composer gate can supply its reason.
      const reason = frame.ready ? expected : "not-ready";
      expect({ outcome: result, writes }, receipt(frame)).toEqual({
        outcome: {
          ...(admitted ? { status: "unresolved", reason: "no-turn-start" } : { status: "refused", reason }),
          bindingGeneration: 0, writesBefore: 0, writesAfter: admitted ? 1 : 0,
          pasteWrites: admitted ? 1 : 0, wrotePhysicalBytes: admitted,
        },
        writes: admitted ? [paste(PROBE), "\r"] : [],
      });
    },
    dispose() {
      drive.resetForTest();
      runtime.stop();
      observer.dispose();
    },
  };
};

describe("Amp standalone recorded initialization and composer readiness", () => {
  for (const mode of CHUNK_MODES) {
    for (const scenario of ["startup-idle", "type-echo", "paste-chip", "working-turn"] as const) {
      it(`${scenario} (${mode}) reconstructs its own grid and governs the shared drive`, async () => {
        const capture = recorded(scenario);
        const gate = replay(`${scenario}-gate`, mode);
        try {
          let final: Frame | undefined;
          for (const bytes of capture.frames) final = await gate.feed(bytes);
          gateFixture(final!.snapshot, capture.fixture);
          expect(final!.snapshot.signals.modes.bracketedPaste, "standalone capture lost its terminal initialization").toBe(true);
        } finally {
          gate.dispose();
        }

        // Behavior gets the same complete recording in another fresh runtime:
        // a saved grid must never be paired with the state of a later frame.
        const behavior = replay(scenario, mode);
        let loadingBoxes = 0;
        let helloDrafts = 0;
        const payloadFrames: string[] = [];
        let pasteDraftSeen = false;
        let sendingBeforeTitle = 0;
        let workingPromptSeen = false;
        let targetWorking = 0;
        let final: Frame | undefined;
        try {
          for (const bytes of capture.frames) {
            const frame = await behavior.feed(bytes);
            final = frame;
            const payload = scenario === "type-echo" ? "hello" : "PASTE_LINE_00";
            if (frame.snapshot.text.includes(payload) && payloadFrames.length < 5) {
              payloadFrames.push(`${receipt(frame)} pending=${promptStillPending(frame.snapshot, payload)}`);
            }
            const loading = /loading thread|connecting|catching up/iu.test(frame.snapshot.text);
            if (hasEmptyBox(frame.snapshot) && loading) {
              loadingBoxes += 1;
              expect(frame.ready, receipt(frame)).toBe(false);
              await behavior.assertAdmission(frame, "not-ready");
            }
            if (scenario === "type-echo" && frame.composer === "draft" && promptStillPending(frame.snapshot, "hello")) {
              helloDrafts += 1;
              await behavior.assertAdmission(frame, frame.idle ? "composer-not-empty" : "seat-busy");
            }
            if (scenario === "paste-chip") {
              // A 40-line paste can scroll its head out of the box. Identify
              // the recorded target by a visible payload endpoint inside a
              // bounded composer row, never by its echoed transcript.
              const visiblePayload = ["PASTE_LINE_00", "PASTE_LINE_39"].find((payload) =>
                frame.snapshot.lines.some((line) => /^\s*│/u.test(line) && line.includes(payload)));
              if (frame.composer === "draft" && visiblePayload !== undefined) {
                pasteDraftSeen = true;
                expect(promptStillPending(frame.snapshot, visiblePayload), receipt(frame)).toBe(true);
                await behavior.assertAdmission(frame, frame.idle ? "composer-not-empty" : "seat-busy");
              }
              const sending = frame.snapshot.lines.filter((line) => line.trim()).slice(-4)
                .some((line) => /^\s*╰\s*[∼≈≋~]\s+Sending\b/u.test(line));
              if (pasteDraftSeen && sending) {
                expect(frame.idle, receipt(frame)).toBe(false);
                await behavior.assertAdmission(frame, "seat-busy");
                if (hasEmptyBox(frame.snapshot) && frame.snapshot.signals.title.length > 0 && !SPINNER.test(frame.snapshot.signals.title)) {
                  sendingBeforeTitle += 1;
                }
              }
            }
            if (scenario === "working-turn") {
              // This recording adds steering during an ongoing turn. It proves
              // refusal while that target text is present, not a new turn ACK.
              workingPromptSeen ||= frame.snapshot.text.includes("Write forty numbered lines.");
              if (workingPromptSeen && frame.state === "working") {
                targetWorking += 1;
                expect(frame.idle, receipt(frame)).toBe(false);
                await behavior.assertAdmission(frame, "seat-busy");
              }
            }
          }
          expect(loadingBoxes, "initial painted box must not bypass loading readiness").toBeGreaterThan(0);
          if (scenario === "startup-idle" || scenario === "type-echo") {
            expect(hasEmptyBox(final!.snapshot), receipt(final!)).toBe(true);
            expect({ composer: final!.composer, idle: final!.idle, ready: final!.ready }, receipt(final!))
              .toEqual({ composer: "empty", idle: true, ready: true });
            if (scenario === "type-echo") {
              expect(helloDrafts, `recorded hello must pass through a protected draft\n${payloadFrames.join("\n")}`).toBeGreaterThan(0);
              expect(promptStillPending(final!.snapshot, "hello"), receipt(final!)).toBe(false);
            }
            // This probes admission only; the ACK test below supplies the PTY
            // response to the drive's actual paste and CR callbacks.
            // No captured response follows this new probe. Admission alone
            // cannot prove submission; the ACK test below proves that separately.
            await behavior.assertAdmission(final!, "admitted");
          } else if (scenario === "paste-chip") {
            expect(pasteDraftSeen, `target paste never appeared as a protected draft\n${payloadFrames.join("\n")}`).toBe(true);
            expect(sendingBeforeTitle, "target paste lacks Sending with an empty box before its title spins").toBeGreaterThan(0);
          } else {
            expect(workingPromptSeen, "this fixture never displayed its own working-turn prompt").toBe(true);
            expect(targetWorking, "no working frame after this scenario's prompt").toBeGreaterThan(0);
          }
        } finally {
          behavior.dispose();
        }
      }, 30_000);
    }
  }
});

it("Amp acknowledges hello through recorded PTY output after the shared drive's paste and CR", async () => {
  const capture = recorded("type-echo");
  const run = replay("recorded-ack", "whole", "hello");
  let next = 0;
  let current: Frame | undefined;
  let pendingSeen = false;
  try {
    while (next < capture.frames.length) {
      current = await run.feed(capture.frames[next++]!);
      if (current.ready && current.idle && current.composer === "empty") break;
    }
    expect(current && current.ready && current.idle && current.composer === "empty", "no initial ready empty composer in this standalone recording").toBe(true);
    expect(next, "capture ended before the recorded hello draft").toBeLessThan(capture.frames.length);
    run.acknowledgements.length = 0;
    // Only the OS boundary is replayed. The bytes are this file's real output
    // in order; this proves recorded acknowledgement, not live injected QA.
    run.setWriteOutput(async (data) => {
      if (data === paste("hello")) {
        while (next < capture.frames.length) {
          current = await run.feed(capture.frames[next++]!);
          if (current.composer === "draft" && promptStillPending(current.snapshot, "hello")) {
            pendingSeen = true;
            break;
          }
        }
        expect(pendingSeen, "paste callback never reached the recorded hello draft").toBe(true);
      } else {
        expect(data, "unexpected recovery/control write").toBe("\r");
        expect(pendingSeen, "CR preceded the recorded pending draft").toBe(true);
        while (next < capture.frames.length) current = await run.feed(capture.frames[next++]!);
      }
    });
    const startedAt = Date.now();
    const submitted = await run.drive.writePrompt(run.bindingId, "hello", {
      queueIfBusy: false,
      awaitTurnStart: true,
      ready: current!.ready,
    });
    expect(submitted, receipt(current!)).toEqual({
      status: "submitted", bindingGeneration: 0,
      writesBefore: 0, writesAfter: 1, pasteWrites: 1, wrotePhysicalBytes: true,
    });
    expect(Date.now() - startedAt, "submission must be acknowledged before the timeout's text-disappeared fallback").toBeLessThan(DEFAULT_PROMPT_STALL_MS);
    expect(run.writes).toEqual([paste("hello"), "\r"]);
    expect(run.acknowledgements, "no captured working event after CR with our text absent from the composer")
      .toContainEqual({ afterCr: true, pending: false });
    expect(run.attention).toEqual([]);
    expect(promptStillPending(current!.snapshot, "hello"), receipt(current!)).toBe(false);
    expect({ composer: current!.composer, idle: current!.idle, ready: current!.ready }, receipt(current!))
      .toEqual({ composer: "empty", idle: true, ready: true });
    gateFixture(current!.snapshot, capture.fixture);
  } finally {
    run.dispose();
  }
}, 30_000);
