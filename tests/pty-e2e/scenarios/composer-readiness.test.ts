import { describe, expect, it } from "vitest";
import { SeatStateRuntime } from "../../../src/main/vellum-command/term/agent-state/runtime";
import { isManagedTerminalReady } from "../../../src/main/vellum-command/term/drive/readiness";
import { createManagedTerminalDrive } from "../../../src/main/vellum-command/term/drive/managed-drive-factory";
import { SessionObserver } from "../../../src/main/vellum-command/term/observer";
import type { ObserverGridSnapshot } from "../../../src/main/vellum-command/term/observer/types";
import { requireCapture } from "../runner";

const FRAME_END = "\x1b[?2026l";

type Frame = {
  readonly index: number;
  readonly snapshot: ObserverGridSnapshot;
  readonly state: ReturnType<SeatStateRuntime["getState"]>;
  readonly reason: string;
  readonly idle: boolean;
  readonly composer: ReturnType<SeatStateRuntime["composerVerdict"]>;
  readonly ready: boolean;
  readonly pasteable: boolean;
};

/** Retain every captured byte and observe only actual synchronized-render ends. */
const replayFrames = async (
  harness: string,
  scenario: string,
  refuseFrame: (frame: Frame) => boolean,
  acceptFinal = false,
): Promise<Frame[]> => {
  const capture = requireCapture(harness, scenario);
  expect(capture.source).toBe("P1");
  const bytes = Buffer.concat(capture.events.map((event) => Buffer.from(event.b64, "base64"))).toString("utf8");
  const chunks: string[] = [];
  let start = 0;
  let end: number;
  while ((end = bytes.indexOf(FRAME_END, start)) !== -1) {
    end += FRAME_END.length;
    chunks.push(bytes.slice(start, end));
    start = end;
  }
  expect(chunks.length, `${harness}/${scenario} has no recorded synchronized frames`).toBeGreaterThan(0);
  if (start < bytes.length) chunks.push(bytes.slice(start));

  const bindingId = `readiness-${harness}-${scenario}`;
  const epoch = "captured-epoch";
  const observer = new SessionObserver({ bindingId, epoch, cols: 120, rows: 32 });
  const runtime = new SeatStateRuntime({ now: () => 1_000_000, turnProgressWatch: false });
  let currentSnapshot: ObserverGridSnapshot | undefined;
  const writes: string[] = [];
  const drive = createManagedTerminalDrive({
    write: (_bindingId, data) => { writes.push(data); return true; },
    isSeatIdle: (id) => runtime.isSeatIdle(id),
    seatState: (id) => runtime.getState(id),
    onAttention: () => {},
    snapshot: () => currentSnapshot,
    composerVerdict: (id) => runtime.composerVerdict(id),
    harnessFor: () => harness,
  });
  const frames: Frame[] = [];
  runtime.bindHarness(bindingId, harness, epoch);
  try {
    for (const [index, chunk] of chunks.entries()) {
      observer.feed(chunk, BigInt(index + 1));
      const snapshot = await observer.snapshot();
      currentSnapshot = snapshot;
      runtime.observe(snapshot);
      const state = runtime.getState(bindingId);
      const idle = runtime.isSeatIdle(bindingId);
      const composer = runtime.composerVerdict(bindingId);
      const ready = isManagedTerminalReady({ harness, seatState: state, snapshot });
      const frame: Frame = {
        index,
        snapshot,
        state,
        reason: runtime.machine.getSlot(bindingId)?.reason ?? "unbound",
        idle,
        composer,
        ready,
        pasteable: ready && idle && composer === "empty",
      };
      frames.push(frame);
      if (refuseFrame(frame)) {
        writes.length = 0;
        const accepted = await drive.writePrompt(bindingId, "review probe", {
          queueIfBusy: false,
          awaitTurnStart: false,
          ready: true,
        });
        expect({ accepted, writes }, receipt(frame)).toEqual({ accepted: false, writes: [] });
      }
    }
    if (acceptFinal) {
      writes.length = 0;
      const accepted = await drive.writePrompt(bindingId, "review probe", {
        queueIfBusy: false,
        awaitTurnStart: false,
        ready: true,
      });
      expect({ accepted, writes }, receipt(frames.at(-1)!)).toEqual({
        accepted: true,
        writes: ["\x1b[200~review probe\x1b[201~", "\r"],
      });
    }
  } finally {
    drive.resetForTest();
    runtime.stop();
    observer.dispose();
  }
  return frames;
};

const receipt = (frame: Frame): string => JSON.stringify({
  frame: frame.index,
  title: frame.snapshot.signals.title,
  state: frame.state,
  reason: frame.reason,
  idle: frame.idle,
  composer: frame.composer,
  ready: frame.ready,
});

const hasEmptyPrompt = (frame: Frame): boolean =>
  frame.snapshot.lines.some((line) => /^\s*(?:❯\s*|│\s*>\s*│)\s*$/u.test(line));

const museThinking = ({ snapshot }: Frame): boolean => {
  const row = snapshot.lines.findIndex((line) => /^\s*◇\s+Thinking/u.test(line));
  const voice = snapshot.lines.findIndex((line) => line.includes("Voice input"));
  return row >= 0 && voice > row;
};

describe("captured intermediate frames govern paste readiness", () => {
  for (const scenario of ["type-echo", "paste-chip", "working-turn"]) {
    it(`Muse ${scenario} refuses the live Thinking frame before the title starts spinning`, async () => {
      const frames = await replayFrames("muse", scenario, museThinking, true);
      const thinking = frames.filter(museThinking);
      expect(thinking.length, `${scenario}: no captured Thinking frame above Voice input`).toBeGreaterThan(0);
      const beforeTitle = thinking.filter((frame) => frame.snapshot.signals.title === "muse");
      expect(beforeTitle.length, `${scenario}: missing the captured working frame with plain muse title`).toBeGreaterThan(0);
      expect(beforeTitle.some(hasEmptyPrompt), `${scenario}: working frame no longer contains the captured empty prompt`).toBe(true);
      for (const frame of thinking) {
        expect(frame.pasteable, receipt(frame)).toBe(false);
        expect(frame.idle, receipt(frame)).toBe(false);
      }
      const final = frames.at(-1)!;
      expect(final.snapshot.lines.some((line) => /^\s*◇\s+Thinking/u.test(line))).toBe(false);
      expect(hasEmptyPrompt(final), `${scenario}: final captured prompt must be visibly empty`).toBe(true);
      expect(final.pasteable, receipt(final)).toBe(true);
    });
  }

  for (const harness of ["hermes", "kimi"]) {
    for (const scenario of ["startup-idle", "type-echo"]) {
      it(`${harness} ${scenario} refuses every captured auth-failure frame despite its empty prompt`, async () => {
        const hasProviderFailure = (frame: Frame): boolean => {
          const screen = frame.snapshot.lines.join("\n");
          return harness === "hermes"
            ? screen.includes("No Codex credentials stored")
            : /Model:\s+not set, run \/login or \/provider/u.test(screen);
        };
        const frames = await replayFrames(harness, scenario, hasProviderFailure);
        const blocked = frames.filter(hasProviderFailure);
        expect(blocked.length, `${harness}/${scenario}: recorded provider failure was not rendered`).toBeGreaterThan(0);
        expect(blocked.some(hasEmptyPrompt), `${harness}/${scenario}: provider failure must coexist with a visibly empty prompt`).toBe(true);
        expect(blocked.some((frame) => frame.index < frames.length - 1), `${harness}/${scenario}: regression must exercise intermediate frames`).toBe(true);
        for (const frame of blocked) {
          expect(frame.pasteable, receipt(frame)).toBe(false);
        }
      });
    }
  }
});
