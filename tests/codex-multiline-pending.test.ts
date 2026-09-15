import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SeatStateRuntime } from "../src/main/vellum-command/term/agent-state/runtime";
import { composerVerdictForHarness } from "../src/main/vellum-command/term/agent-state/composer";
import { createManagedTerminalDrive } from "../src/main/vellum-command/term/drive/managed-drive-factory";
import { promptHasPasteChip, promptStillPending } from "../src/main/vellum-command/term/drive/prompt-evidence";
import { isManagedTerminalReady } from "../src/main/vellum-command/term/drive/readiness";
import { SessionObserver } from "../src/main/vellum-command/term/observer";
import { codexMultilineComposerEvidence, pendingEvidenceLines } from "../src/main/vellum-command/term/observer/interaction";
import type { ObserverGridSnapshot } from "../src/main/vellum-command/term/observer/types";

const FRAME_END = "\x1b[?2026l";
const corpus = new URL("./pty-e2e/corpus/codex/paste-chip.jsonl", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("./pty-e2e/corpus/codex/manifest.json", import.meta.url), "utf8"));
const payload: string = manifest.scenarios.find((scenario: { scenario: string }) => scenario.scenario === "paste-chip").expectedScreen.pasteText;
const recordedFrames = () => {
  const bytes = readFileSync(corpus, "utf8").trim().split("\n")
    .map((line) => Buffer.from(JSON.parse(line).b64, "base64").toString("utf8")).join("");
  const frames: string[] = [];
  let start = 0;
  for (let end; (end = bytes.indexOf(FRAME_END, start)) !== -1;) {
    end += FRAME_END.length;
    frames.push(bytes.slice(start, end));
    start = end;
  }
  if (start < bytes.length) frames[frames.length - 1] += bytes.slice(start);
  return frames;
};

describe("recorded Codex multiline composer", () => {
  it("retains positive pending evidence when the literal composer exceeds the bottom ten rows", async () => {
    const bindingId = "codex-recorded-multiline";
    const epoch = "recorded-codex-0.147";
    const observer = new SessionObserver({ bindingId, epoch, cols: 120, rows: 32 });
    const runtime = new SeatStateRuntime({ now: () => 1_000_000, turnProgressWatch: false });
    runtime.bindHarness(bindingId, "codex", epoch);
    let pendingFrames = 0;
    const historyFrames: number[] = [];
    try {
      for (const [index, frame] of recordedFrames().entries()) {
        observer.feed(frame, BigInt(index + 1));
        const snapshot = await observer.snapshot();
        runtime.observe(snapshot);
        const glyph = snapshot.lines.findLastIndex((line) => /^\s*›/u.test(line));
        if (glyph >= 0 && snapshot.lines[glyph]!.includes("PASTE_LINE_00")) {
          pendingFrames += 1;
          expect(glyph).toBeLessThan(snapshot.lines.length - 10);
          expect(snapshot.lines.slice(glyph, glyph + 15).map((line) => line.replace(/^› |^  /u, "")))
            .toEqual(payload.split("\n"));
          expect(promptStillPending(snapshot, payload), `recorded frame ${index}`).toBe(true);
          expect(runtime.composerVerdict(bindingId), `recorded frame ${index}`).toBe("draft");
          expect(promptHasPasteChip(snapshot)).toBe(false);
        }
        if (index === 128 || index === 130) {
          historyFrames.push(index);
          expect(snapshot.text).toContain("PASTE_LINE_00");
          expect(snapshot.lines[glyph]).toBe("› Implement {feature}");
          expect(promptStillPending(snapshot, payload)).toBe(false);
          expect(runtime.composerVerdict(bindingId)).toBe("empty");
          if (index === 130) expect(runtime.getState(bindingId)).toBe("working");
        }
      }
      expect(pendingFrames).toBe(17);
      expect(historyFrames).toEqual([128, 130]);
    } finally {
      runtime.stop();
      observer.dispose();
    }
  });

  it("submits the recorded 15-line payload through the shared drive using only adjacent native response frames", async () => {
    const bindingId = "codex-recorded-multiline-drive";
    const epoch = "recorded-codex-0.147";
    const frames = recordedFrames();
    const observer = new SessionObserver({ bindingId, epoch, cols: 120, rows: 32 });
    const runtime = new SeatStateRuntime({ now: () => 1_000_000, turnProgressWatch: false });
    runtime.bindHarness(bindingId, "codex", epoch);
    let snapshot: ObserverGridSnapshot | undefined;
    let next = 0;
    const writes: string[] = [];
    const attention: string[] = [];
    const paste = `\x1b[200~${payload}\x1b[201~`;
    const drive = createManagedTerminalDrive({
      write: async (_id, data) => {
        writes.push(data);
        if (data === paste) {
          expect(next).toBe(127);
          await feedNext();
          expect(promptStillPending(snapshot!, payload)).toBe(true);
          expect(runtime.composerVerdict(bindingId)).toBe("draft");
          expect(promptHasPasteChip(snapshot!)).toBe(false);
        } else if (data === "\r") {
          expect(next).toBe(128);
          while (next <= 130) await feedNext();
        } else {
          throw new Error(`Unexpected write ${JSON.stringify(data)}`);
        }
        return true;
      },
      isSeatIdle: (id) => runtime.isSeatIdle(id),
      seatState: (id) => runtime.getState(id),
      onAttention: (_id, reason) => attention.push(reason),
      snapshot: () => snapshot,
      composerVerdict: (id) => runtime.composerVerdict(id),
      harnessFor: () => "codex",
    });
    const feedNext = async () => {
      observer.feed(frames[next++]!, BigInt(next));
      snapshot = await observer.snapshot();
      const event = runtime.observe(snapshot);
      if (event?.state === "working") drive.onTurnStart(bindingId);
      if (event?.state === "idle") drive.onSeatIdle(bindingId);
    };
    try {
      // The recording includes its own initialization and earlier hello turn.
      // Continue to the exact empty frame immediately before this paste.
      while (next <= 126) await feedNext();
      expect(runtime.isSeatIdle(bindingId)).toBe(true);
      expect(runtime.composerVerdict(bindingId)).toBe("empty");
      const outcome = await drive.writePrompt(bindingId, payload, {
        queueIfBusy: false,
        awaitTurnStart: true,
        ready: isManagedTerminalReady({ harness: "codex", seatState: runtime.getState(bindingId), snapshot }),
      });
      expect(outcome).toMatchObject({ status: "submitted", pasteWrites: 1, wrotePhysicalBytes: true });
      expect(writes).toEqual([paste, "\r"]);
      expect(attention).toEqual([]);
      expect(runtime.getState(bindingId)).toBe("working");
      expect(runtime.composerVerdict(bindingId)).toBe("empty");
      expect(promptStillPending(snapshot!, payload)).toBe(false);
    } finally {
      drive.resetForTest();
      runtime.stop();
      observer.dispose();
    }
  });
});

describe("Codex multiline evidence boundaries", () => {
  const body = ["› old payload", ...Array.from({ length: 14 }, (_, i) => `  old continuation ${i}`)];
  const snapshotOf = (lines: readonly string[]): ObserverGridSnapshot => ({
    bindingId: "codex-layout", epoch: "layout", seq: 1n, cols: 120, rows: 32, lines, text: lines.join("\n"),
    signals: { title: "", osc9: "", modes: { bracketedPaste: true, synchronizedOutput: false, altScreen: false, mouseModes: [] } },
  });

  it.each([
    ["working chrome", ["• Working (0s • esc to interrupt)", "", "  footer"]],
    ["response output", ["A completed response", "", "  footer"]],
    ["attention chrome", ["Allow command? [y/n]", "", "  footer"]],
    ["a nearer non-Codex glyph", ["❯ another composer", ...Array(12).fill("  continuation")]],
    ["a nearer indented glyph", ["  › quoted text", ...Array(12).fill("  continuation")]],
  ] as const)("does not search past %s to recover an older prompt", (_label, tail) => {
    const snapshot = snapshotOf([...body, ...tail]);
    expect(codexMultilineComposerEvidence(snapshot.lines)).toBeUndefined();
    expect(promptStillPending(snapshot, "old payload")).toBe(false);
    expect(composerVerdictForHarness(snapshot, "codex")).toBeNull();
  });

  it("keeps a newer empty composer authoritative over the submitted multiline history", () => {
    const snapshot = snapshotOf([...body, "", "› Implement {feature}", "", "  gpt-5.4-mini low"]);
    expect(pendingEvidenceLines(snapshot.lines)).toEqual(snapshot.lines.slice(-3));
    expect(promptStillPending(snapshot, "old payload")).toBe(false);
    expect(composerVerdictForHarness(snapshot, "codex")).toBe("empty");
  });
});
