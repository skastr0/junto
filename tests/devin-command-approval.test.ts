import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SeatReadResult } from "../src/shared/seat-control";
import { evaluate, SeatStateRuntime } from "../src/main/junto/term/agent-state";
import type { ObserverGridSnapshot } from "../src/main/junto/term/observer/types";

// Exact decoded SeatReadResult from the isolated native Devin session on
// 2026-09-15, before the operator approved `junto onboard`.
// Source: /tmp/junto-devin-command-approval-20260915.json.
// JSON unicode escapes preserve every captured character, including its footer.
const captured = Schema.decodeUnknownSync(SeatReadResult)(JSON.parse(readFileSync(
  new URL("./fixtures/devin-command-approval-seat-read.json", import.meta.url), "utf8",
)));

const snapshot = (text = captured.text, seq = captured.seq): ObserverGridSnapshot => ({
  bindingId: "devin-command-approval",
  epoch: captured.epoch,
  seq: BigInt(seq),
  cols: 140,
  rows: captured.lineCount,
  lines: text.split("\n"),
  text,
  signals: {
    title: "",
    osc9: "",
    modes: { bracketedPaste: true, synchronizedOutput: false, altScreen: false, mouseModes: [] },
  },
});

// The grounded empty composer from the existing Devin startup-idle capture.
const idlePrompt = "❭ Ask Devin to build features, fix bugs, or work on your code";
const hr = "────────────────";

describe("Devin native command approval replay", () => {
  it("recognizes the captured eight-option chooser as visible attention", () => {
    expect(Buffer.byteLength(captured.text)).toBe(captured.bytes);
    expect(captured.text.split("\n")).toHaveLength(captured.lineCount);
    expect(captured).toMatchObject({ state: "idle", confidence: "low", reason: "default_known_agent_idle_fallback" });
    expect(evaluate(snapshot(), { harness: "devin" })).toMatchObject({
      state: "attention",
      confidence: "high",
      reason: "rule:permission_prompt",
      visibleAttention: true,
    });
  });

  it("leaves attention when the captured chooser becomes history above an idle composer", () => {
    const runtime = new SeatStateRuntime();
    const grid = snapshot();
    runtime.bindHarness(grid.bindingId, "devin", grid.epoch);
    try {
      runtime.machine.feed(grid, { harness: "devin" });
      expect(runtime.getState(grid.bindingId)).toBe("attention");
      expect(runtime.isSeatIdle(grid.bindingId)).toBe(false);
      const after = snapshot(`${captured.text}\n\n${hr}\n${idlePrompt}\n${hr}`, captured.seq + 1);
      runtime.machine.feed(after, { harness: "devin" });
      expect(runtime.getState(grid.bindingId)).toBe("idle");
      expect(runtime.machine.getSlot(grid.bindingId)?.visibleAttention).toBe(false);
      expect(runtime.isSeatIdle(grid.bindingId)).toBe(true);
    } finally {
      runtime.stop();
    }
  });

  it("does not treat quoted approval controls inside the bounded recent region as current", () => {
    const lines = captured.text.split("\n");
    const selected = lines.find((line) => line.includes("(Approve once)"));
    const footer = lines.at(-1);
    if (selected === undefined || footer === undefined) throw new Error("Approval capture is incomplete");
    // Both old approval markers remain within the nine-line matcher window.
    // The visible composer, rather than the old control footer, ends the frame.
    const history = [selected, footer, "command output 1", "command output 2", "command output 3",
      "command output 4", hr, idlePrompt, hr].join("\n");
    expect(evaluate(snapshot(history), { harness: "devin" })).toMatchObject({
      state: "idle",
      confidence: "high",
      visibleAttention: false,
      visibleIdle: true,
    });
  });
});
