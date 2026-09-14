import { expect, it } from "vitest";
import { SeatStateRuntime } from "../../../src/main/vellum-command/term/agent-state/runtime";
import { createManagedTerminalDrive } from "../../../src/main/vellum-command/term/drive/managed-drive-factory";
import { SessionObserver } from "../../../src/main/vellum-command/term/observer";
import type { ObserverGridSnapshot } from "../../../src/main/vellum-command/term/observer/types";
import { requireCapture } from "../runner";

const FRAME_END = "\x1b[?2026l";

/** The committed Amp tails require the earlier startup and greeting paints. */
const capturedFrames = (scenario: string): string[] => {
  const capture = requireCapture("amp", scenario);
  expect(capture.source).toBe("P1");
  const bytes = Buffer.concat(capture.events.map((event) => Buffer.from(event.b64, "base64"))).toString("utf8");
  const frames: string[] = [];
  let start = 0;
  let end: number;
  while ((end = bytes.indexOf(FRAME_END, start)) !== -1) {
    end += FRAME_END.length;
    frames.push(bytes.slice(start, end));
    start = end;
  }
  expect(frames.length, `amp/${scenario} has no captured synchronized renders`).toBeGreaterThan(0);
  if (start < bytes.length) frames.push(bytes.slice(start));
  return frames;
};

const hasEmptyBox = (snapshot: ObserverGridSnapshot): boolean => {
  const lines = snapshot.lines.filter((line) => line.trim()).slice(-8);
  return lines.some((line) => /^\s*╭─/u.test(line)) &&
    lines.some((line) => /^\s*│\s*│\s*$/u.test(line));
};

it("Amp refuses Sending before its title changes and still admits the preceding idle greeting", async () => {
  const bindingId = "amp-sending-real-capture";
  const epoch = "captured-epoch";
  const observer = new SessionObserver({ bindingId, epoch, cols: 120, rows: 32 });
  const runtime = new SeatStateRuntime({ now: () => 1_000_000, turnProgressWatch: false });
  let currentSnapshot: ObserverGridSnapshot | undefined;
  const writes: string[] = [];
  const drive = createManagedTerminalDrive({
    write: (_id, data) => { writes.push(data); return true; },
    isSeatIdle: (id) => runtime.isSeatIdle(id),
    seatState: (id) => runtime.getState(id),
    onAttention: () => {},
    snapshot: () => currentSnapshot,
    composerVerdict: (id) => runtime.composerVerdict(id),
    harnessFor: () => "amp",
  });
  runtime.bindHarness(bindingId, "amp", epoch);
  let seq = 0n;
  let sendingFrames = 0;
  let emptySendingBeforeTitle = 0;
  const receipt = (scenario: string, frame: number): string => JSON.stringify({
    scenario,
    frame,
    title: currentSnapshot?.signals.title,
    state: runtime.getState(bindingId),
    reason: runtime.machine.getSlot(bindingId)?.reason,
    idle: runtime.isSeatIdle(bindingId),
    composer: runtime.composerVerdict(bindingId),
  });

  try {
    // These are sequential segments of the same recorded PTY session. Feeding
    // paste-chip into a blank terminal loses its composer and idle title.
    for (const scenario of ["startup-idle", "type-echo", "paste-chip"]) {
      const frames = capturedFrames(scenario);
      for (const [frame, bytes] of frames.entries()) {
        observer.feed(bytes, ++seq);
        const snapshot = await observer.snapshot();
        currentSnapshot = snapshot;
        runtime.observe(snapshot);
        if (scenario !== "paste-chip") continue;
        const footer = snapshot.lines.filter((line) => line.trim()).slice(-4);
        if (!footer.some((line) => /^\s*╰\s*[∼≈≋~]\s+Sending\b/u.test(line))) continue;
        sendingFrames += 1;
        if (snapshot.signals.title.startsWith("Greeting - amp - ") &&
            !/[\u2800-\u28ff]/u.test(snapshot.signals.title) && hasEmptyBox(snapshot)) {
          emptySendingBeforeTitle += 1;
        }
        writes.length = 0;
        const accepted = await drive.writePrompt(bindingId, "review probe", {
          queueIfBusy: false,
          awaitTurnStart: false,
          ready: true,
        });
        expect({ accepted, writes }, receipt(scenario, frame)).toEqual({ accepted: false, writes: [] });
      }

      if (scenario === "type-echo") {
        const snapshot = currentSnapshot!;
        expect(snapshot.text).toContain("Hello — how can I help?");
        expect(snapshot.signals.title).toMatch(/^Greeting - amp - /u);
        expect(snapshot.signals.title).not.toMatch(/[\u2800-\u28ff]/u);
        expect(hasEmptyBox(snapshot), "the recorded greeting must settle to a visibly empty box").toBe(true);
        expect(runtime.composerVerdict(bindingId)).toBe("empty");
        writes.length = 0;
        const accepted = await drive.writePrompt(bindingId, "review probe", {
          queueIfBusy: false,
          awaitTurnStart: false,
          ready: true,
        });
        expect({ accepted, writes }, receipt(scenario, frames.length - 1)).toEqual({
          accepted: true,
          writes: ["\x1b[200~review probe\x1b[201~", "\r"],
        });
      }
    }
    expect(sendingFrames, "captured Sending footer was never rendered").toBeGreaterThan(0);
    expect(emptySendingBeforeTitle, "missing captured Sending frame with an empty box and plain Greeting title").toBeGreaterThan(0);
  } finally {
    drive.resetForTest();
    runtime.stop();
    observer.dispose();
  }
});
