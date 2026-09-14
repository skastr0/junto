/**
 * Native 54f79b07 delivery journal, rows 86–109: admission was idle/empty;
 * strict idle dropped at +28ms and the +80ms check refused without any CR.
 * The captured composer held our chip in place of Devin's idle placeholder.
 *
 * Replay the sanitized pending capture through the real headless observer,
 * state runtime and shared destination factory. Welcome, working, permission
 * and literal-draft variants alter only composer/footer lines; they are
 * controlled rule-pack inputs, not claims of additional native captures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluate } from "../src/main/vellum-command/term/agent-state/engine";
import { SeatStateRuntime } from "../src/main/vellum-command/term/agent-state/runtime";
import { createManagedTerminalDrive } from "../src/main/vellum-command/term/drive/managed-drive-factory";
import { attachManagedTerminalDriveRuntime } from "../src/main/vellum-command/term/drive/managed-drive-runtime";
import {
  promptHasPasteChip,
  promptStillPending,
} from "../src/main/vellum-command/term/drive/prompt-evidence";
import { encodeBracketedPaste } from "../src/main/vellum-command/term/drive/typing";
import { SessionObserver } from "../src/main/vellum-command/term/observer/session-observer";
import type { ObserverGridSnapshot } from "../src/main/vellum-command/term/observer/types";
import pendingFrame from "./fixtures/pty-own-paste-pending-frame.json";

const PAYLOAD = Array.from({ length: 73 }, (_, i) => `test handoff line ${i + 1}`).join("\n");
const CHIP_ROW = pendingFrame.lines.findIndex((line) => line.startsWith("❭"));
const WORKING = "running tools (esc to interrupt)";
const PERMISSION = "approve once / select / confirm / esc cancel";

const variant = (composer: string, footer?: string): string[] =>
  pendingFrame.lines.map((line, index) =>
    index === CHIP_ROW ? composer :
      index === pendingFrame.rows - 1 && footer !== undefined ? footer : line,
  );

const cleanups: Array<() => void> = [];
let nextBinding = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

const createSeat = () => {
  const bindingId = `native-own-paste-${++nextBinding}`;
  const epoch = "test-generation";
  const observer = new SessionObserver({
    bindingId, epoch, cols: pendingFrame.cols, rows: pendingFrame.rows,
  });
  const runtime = new SeatStateRuntime({ turnProgressWatch: false });
  runtime.bindHarness(bindingId, "devin", epoch);
  let frame: ObserverGridSnapshot | undefined;
  let seq = 0n;
  const writes: Array<{ data: string; at: number; strictIdle: boolean }> = [];
  const attention: string[] = [];
  const drive = createManagedTerminalDrive({
    write: (id, data) => {
      writes.push({ data, at: Date.now(), strictIdle: runtime.isSeatIdle(id) });
      return true;
    },
    isSeatIdle: (id) => runtime.isSeatIdle(id),
    seatState: (id) => runtime.getState(id),
    composerVerdict: (id) => runtime.composerVerdict(id),
    harnessFor: () => "devin",
    snapshot: () => frame,
    onAttention: (id, reason) => {
      attention.push(reason);
      runtime.machine.force(id, "attention", reason, "high");
    },
  });
  const detach = attachManagedTerminalDriveRuntime(drive, {
    // This fixture has one stable generation, with no process lifecycle events.
    subscribeHostEvents: () => () => {},
    subscribeSeatState: (listener) => runtime.subscribe(listener),
    subscribeComposerEmpty: (listener) => runtime.subscribeComposerVerdict((id, verdict) => {
      if (verdict === "empty") listener(id);
    }),
    harnessFor: () => "devin",
    snapshotText: () => frame?.text,
  });
  cleanups.push(() => {
    detach();
    drive.suspend();
    runtime.stop();
    observer.dispose();
  });

  const observe = async (lines: readonly string[]) => {
    observer.feed(`\x1b[2J\x1b[H${lines.join("\r\n")}`, ++seq);
    const settled = observer.snapshot();
    // Flush xterm's asynchronous write at this exact clock tick; snapshot()
    // explicitly drains the observer buffer, bypassing its sampling floor.
    await vi.advanceTimersByTimeAsync(0);
    frame = await settled;
    runtime.observe(frame);
    return frame;
  };
  const admit = async (text: string) => {
    await observe(variant("❭ Ask Devin to build features, fix bugs, or work on your code"));
    expect(runtime.isSeatIdle(bindingId)).toBe(true);
    expect(runtime.composerVerdict(bindingId)).toBe("empty");
    const result: { value: boolean | undefined } = { value: undefined };
    const delivery = drive.writePrompt(bindingId, text, { queueIfBusy: false });
    void delivery.then((value) => { result.value = value; });
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toEqual([{ data: encodeBracketedPaste(text), at: 0, strictIdle: true }]);
    expect(drive.pasteWriteCount(bindingId)).toBe(1);
    return { delivery, result };
  };
  return { bindingId, runtime, drive, writes, attention, observe, admit };
};

describe("own paste replaces Devin idle chrome", () => {
  it("submits the captured pending chip after settle and receipts only when the draft leaves", async () => {
    const seat = createSeat();
    const { delivery, result } = await seat.admit(PAYLOAD);
    await vi.advanceTimersByTimeAsync(28);
    const pending = await seat.observe(pendingFrame.lines);
    expect(pending.lines).toEqual(pendingFrame.lines);
    expect(pending.cols).toBe(136);
    expect(pending.rows).toBe(37);
    expect(Date.now()).toBe(28);
    expect(evaluate(pending, { harness: "devin" })).toMatchObject({
      state: "idle", reason: "default_known_agent_idle_fallback",
      confidence: "low", visibleIdle: false, ruleId: null,
    });
    expect(seat.runtime.getState(seat.bindingId)).toBe("idle");
    expect(seat.runtime.composerVerdict(seat.bindingId)).toBe("draft");
    expect(seat.runtime.isSeatIdle(seat.bindingId)).toBe(false);
    expect(promptHasPasteChip(pending)).toBe(true);
    expect(promptStillPending(pending, PAYLOAD)).toBe(true);

    await vi.advanceTimersByTimeAsync(52);
    expect(seat.writes.slice(1)).toEqual([
      { data: "\r", at: 80, strictIdle: false },
      { data: "\r", at: 80, strictIdle: false },
    ]);
    expect(result.value).toBeUndefined();
    expect(seat.attention).toEqual([]);

    const submitted = await seat.observe(variant("❭", WORKING));
    expect(promptStillPending(submitted, PAYLOAD)).toBe(false);
    await expect(delivery).resolves.toBe(true);
    expect(seat.writes).toHaveLength(3);
    expect(seat.attention).toEqual([]);
  });

  it.each([
    ["working", WORKING],
    ["attention", PERMISSION],
  ])("writes no CR when %s appears over the pending chip during settle", async (state, footer) => {
    const seat = createSeat();
    const { delivery } = await seat.admit(PAYLOAD);
    await vi.advanceTimersByTimeAsync(28);
    const pending = await seat.observe(variant(pendingFrame.lines[CHIP_ROW], footer));
    expect(seat.runtime.getState(seat.bindingId)).toBe(state);
    expect(promptStillPending(pending, PAYLOAD)).toBe(true);
    await vi.advanceTimersByTimeAsync(52);
    await expect(delivery).resolves.toBe(false);
    expect(seat.writes.map(({ data }) => data)).toEqual([encodeBracketedPaste(PAYLOAD)]);
    expect(seat.attention).toContain("prompt-stalled");
    // The accepted, unresolved paste must not be pasted again by a caller retry.
    await expect(seat.drive.writePrompt(seat.bindingId, PAYLOAD, { queueIfBusy: false })).resolves.toBe(false);
    expect(seat.writes).toHaveLength(1);
  });

  it("continues a literal draft and recovers once without repasting it", async () => {
    const seat = createSeat();
    const text = "literal factory handoff";
    const { delivery, result } = await seat.admit(text);
    await vi.advanceTimersByTimeAsync(28);
    const pending = await seat.observe(variant(`❭ ${text}`));
    expect(seat.runtime.getState(seat.bindingId)).toBe("idle");
    expect(seat.runtime.isSeatIdle(seat.bindingId)).toBe(false);
    expect(seat.runtime.composerVerdict(seat.bindingId)).toBe("draft");
    expect(promptHasPasteChip(pending)).toBe(false);
    expect(promptStillPending(pending, text)).toBe(true);
    await vi.advanceTimersByTimeAsync(52);
    expect(seat.writes.slice(1)).toEqual([{ data: "\r", at: 80, strictIdle: false }]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(seat.writes.slice(1)).toEqual([
      { data: "\r", at: 80, strictIdle: false },
      { data: "\r", at: 5_080, strictIdle: false },
    ]);
    expect(result.value).toBeUndefined();
    const submitted = await seat.observe(variant("❭", WORKING));
    expect(promptStillPending(submitted, text)).toBe(false);
    await expect(delivery).resolves.toBe(true);
    expect(seat.drive.pasteWriteCount(seat.bindingId)).toBe(1);
    expect(seat.writes).toHaveLength(3);
    expect(seat.attention).toEqual([]);
  });
});
