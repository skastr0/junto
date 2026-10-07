/**
 * An offboard accepted between a delivery's paste and its submit.
 *
 * The drive types a message as two writes: the paste, then, a settle later,
 * a separate carriage return. App walk SB-again-claude offboarded a seat in
 * that gap and the old process still received the bare return. On a real
 * harness a stray Enter submits whatever is in the box.
 *
 * Real drive and mail gate over a scripted TUI, with the closing fence in
 * front of the drive's write exactly as ipc.ts puts it there.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClosingFence, fencedWriter } from "../../../src/main/junto/term/closing-fence";
import { BRACKETED_PASTE_START, OperatorInterlock } from "../../../src/main/junto/term/drive";
import { DriveLoop } from "../scripted-tui";

const BINDING = "seat-b1";

const setup = () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const fence = new ClosingFence();
  fence.setLiveGeneration(() => "e1");
  const gate = fencedWriter(fence, () => true, false);
  const holder: { loop?: DriveLoop } = {};
  const loop = new DriveLoop({
    harness: "claude",
    now: () => Date.now(),
    stallTimeoutMs: 5_000,
    pasteToCrSettleMs: 80,
    writeGate: gate,
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
  const flush = async () => {
    await vi.advanceTimersByTimeAsync(1);
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  };
  return { loop, fence, flush };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("an offboard accepted between a delivery's paste and its submit", () => {
  it.each([
    ["mail", (loop: DriveLoop) => loop.drive.writeMail(BINDING, "mail from Mailer: wire the parser")],
    ["a prompt", (loop: DriveLoop) => loop.drive.writePrompt(BINDING, "wire the parser", { ready: true })],
  ] as const)("%s: the submit never reaches the session that offboarded", async (_name, deliver) => {
    const { loop, fence, flush } = setup();
    await flush();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(loop.runtime.getState(BINDING)).toBe("idle");

    const outcome = deliver(loop);
    // Step to the instant the paste has been written and nothing else.
    for (let i = 0; i < 200 && !loop.writes.some((write) => write.data.startsWith(BRACKETED_PASTE_START)); i += 1) {
      await vi.advanceTimersByTimeAsync(1);
    }
    const afterPaste = loop.writes.length;
    expect(loop.writes.at(-1)?.data.startsWith(BRACKETED_PASTE_START)).toBe(true);

    // junto offboard is accepted here: the seat is sealed.
    fence.seal(BINDING);
    await vi.advanceTimersByTimeAsync(10_000);
    await flush();

    expect(loop.writes.slice(afterPaste).map((write) => write.data)).toEqual([]);
    expect(await outcome).not.toBe("written");
  });
});
