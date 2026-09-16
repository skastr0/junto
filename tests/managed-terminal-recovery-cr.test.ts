import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CR,
  ManagedTerminalDrive,
  OperatorInterlock,
  encodeBracketedPaste,
} from "../src/main/junto/term/drive";
import { isLiveClaudeResumeSummaryChoice } from "../src/main/junto/term/drive/claude-startup";
import {
  claudeRules,
  ruleMatches,
} from "../src/main/junto/term/agent-state";
import type { ObserverGridSnapshot } from "../src/main/junto/term/observer/types";

describe("recovery CR (harness-owned selector submit)", () => {
  const drives: ManagedTerminalDrive[] = [];
  const makeDrive = (
    options: Partial<ConstructorParameters<typeof ManagedTerminalDrive>[0]> = {},
  ) => {
    const drive = new ManagedTerminalDrive({
      write: () => true,
      isSeatIdle: () => true,
      pasteToCrSettleMs: 0,
      stallWatch: false,
      stallTimeoutMs: 10,
      operatorInput: new OperatorInterlock(),
      ...options,
    });
    drives.push(drive);
    return drive;
  };
  afterEach(() => {
    for (const drive of drives.splice(0)) drive.resetForTest();
    vi.useRealTimers();
  });

  it("writes one bare CR on a clean binding without opening a turn", async () => {
    const writes: string[] = [];
    const drive = makeDrive({
      write: (bindingId, data) => {
        writes.push(data);
        if (data === CR && writes.length > 1) drive.onTurnStart(bindingId);
        return true;
      },
    });
    await expect(drive.submitRecoveryCr("seat")).resolves.toBe(true);
    expect(writes).toEqual([CR]);
    // No turn was opened: a prompt afterwards still delivers normally.
    await expect(drive.writePrompt("seat", "hello")).resolves.toEqual({
      status: "submitted", bindingGeneration: 0,
      writesBefore: 0, writesAfter: 1, pasteWrites: 1, wrotePhysicalBytes: true,
    });
    expect(writes).toEqual([CR, encodeBracketedPaste("hello"), CR]);
  });

  it("refuses while a paste is unresolved instead of submitting the stuck chip", async () => {
    const writes: string[] = [];
    const attention: string[] = [];
    const drive = makeDrive({
      write: (_bindingId, data) => { writes.push(data); return true; },
      pendingText: () => true,
      onAttention: (_bindingId, reason) => { attention.push(reason); },
    });
    await expect(drive.writePrompt("seat", "first\nprompt")).resolves.toEqual({
      status: "unresolved", reason: "chip-pending", bindingGeneration: 0,
      writesBefore: 0, writesAfter: 1, pasteWrites: 1, wrotePhysicalBytes: true,
    });
    const before = writes.length;
    await expect(drive.submitRecoveryCr("seat")).resolves.toBe(false);
    expect(writes).toHaveLength(before);
    expect(attention).toContain("prompt-stalled");
    // The wedge is preserved, not papered over: later prompts still refuse.
    await expect(drive.writePrompt("seat", "retry")).resolves.toEqual({
      status: "refused", reason: "written-unresolved", bindingGeneration: 0,
      writesBefore: 1, writesAfter: 1, pasteWrites: 0, wrotePhysicalBytes: false,
    });
    expect(writes).toHaveLength(before);
  });

  it("refuses while a submission span is in flight", async () => {
    let releasePaste!: (ok: boolean) => void;
    const gate = new Promise<boolean>((resolve) => { releasePaste = resolve; });
    const writes: string[] = [];
    const drive = makeDrive({
      write: (bindingId, data) => {
        writes.push(data);
        if (data === CR) drive.onTurnStart(bindingId);
        return data === CR ? true : gate;
      },
    });
    const prompt = drive.writePrompt("seat", "in flight");
    await Promise.resolve();
    await expect(drive.submitRecoveryCr("seat")).resolves.toBe(false);
    releasePaste(true);
    await expect(prompt).resolves.toEqual({
      status: "submitted", bindingGeneration: 0,
      writesBefore: 0, writesAfter: 1, pasteWrites: 1, wrotePhysicalBytes: true,
    });
    expect(writes).toEqual([encodeBracketedPaste("in flight"), CR]);
  });
});

describe("live resume-selector gate", () => {
  // Frame shapes reuse the existing selector fixture (claude-startup.test.ts)
  // and the rule-pack permission chrome; no invented selector layout and no
  // raw PTY capture claimed.
  const SELECTOR = [
    "This session is 1h 52m old and 207.2k tokens.",
    "1. Resume from summary (recommended)",
    "2. Resume full session as-is",
    "Enter to confirm - Esc to cancel",
  ];
  const PERMISSION = [
    "Do you want to proceed?",
    "1. Yes",
    "2. No",
    "Enter to select - Esc to cancel",
  ];
  const RULE = "─".repeat(40);

  it("matches the existing rule-free selector fixture", async () => {
    expect(isLiveClaudeResumeSummaryChoice(SELECTOR)).toBe(true);
  });

  it("matches a live selector below a transcript rule", async () => {
    expect(
      isLiveClaudeResumeSummaryChoice(["older turn output", RULE, ...SELECTOR]),
    ).toBe(true);
  });

  it("rejects a stale selector above a live permission dialog", async () => {
    // Every phrase is present viewport-wide, but Enter would answer the
    // permission form, not the selector.
    expect(
      isLiveClaudeResumeSummaryChoice([...SELECTOR, RULE, ...PERMISSION]),
    ).toBe(false);
  });

  it("rejects live permission chrome sharing the selector tail", async () => {
    expect(
      isLiveClaudeResumeSummaryChoice([...SELECTOR, "Enter to select"]),
    ).toBe(false);
  });
});

describe("resume selector state rule is live-region only", () => {
  const snap = (lines: readonly string[]): ObserverGridSnapshot => ({
    cols: 80,
    rows: 24,
    lines,
    text: lines.join("\n"),
    signals: {
      title: "",
      osc9: "",
      modes: {
        bracketedPaste: false,
        synchronizedOutput: false,
        altScreen: false,
        mouseModes: [],
      },
    },
    seq: 1n,
    epoch: "e1",
    bindingId: "b1",
  });
  const RULE = "─".repeat(40);
  const SELECTOR = [
    "1. Resume from summary (recommended)",
    "2. Resume full session as-is",
    "Enter to confirm - Esc to cancel",
  ];
  const rule = claudeRules.rules.find((r) => r.id === "resume_summary_choice")!;

  it("matches a live selector below the last rule", async () => {
    expect(ruleMatches(rule, snap(["older output", RULE, ...SELECTOR]))).toBe(true);
  });

  it("does not pin attention on a stale selector above a live composer", async () => {
    expect(ruleMatches(rule, snap([...SELECTOR, RULE, "❯"]))).toBe(false);
  });
});
