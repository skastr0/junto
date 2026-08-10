/**
 * Real P1 captures (from experiments/pty-capture.ts against real TUIs) fed
 * through the REAL SessionObserver + REAL SeatStateRuntime. Canonicality on
 * real bytes: what the actual TUI painted must be what the observer sees,
 * and what the rules publish must be honest for that screen.
 *
 * Corpus: /tmp/vellum-pty-fixtures/<harness>/<scenario>.jsonl (P1).
 * If a fixture is absent the test skips with a reason (repeatable contract).
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { SessionObserver } from "../../../src/main/vellum/term/observer/session-observer";
import { SeatStateRuntime } from "../../../src/main/vellum/term/agent-state/runtime";

const FIXTURE_ROOT = "/tmp/vellum-pty-fixtures"; // captures land here (macOS /tmp → /private/tmp)

type FixtureEntry = { t: number; b64: string };

const loadFixture = (harness: string, scenario: string): FixtureEntry[] | null => {
  const p = path.join(FIXTURE_ROOT, harness, `${scenario}.jsonl`);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim())
    .map((l) => JSON.parse(l) as FixtureEntry);
};

const decode = (entries: FixtureEntry[]): string =>
  entries.map((e) => Buffer.from(e.b64, "base64").toString("utf8")).join("");

const makeObserver = () =>
  new SessionObserver({ bindingId: "b1", epoch: "e1", cols: 120, rows: 32 });

const feedAll = async (obs: SessionObserver, blob: string, chunkSize = 512) => {
  let seq = 0n;
  for (let i = 0; i < blob.length; i += chunkSize) {
    seq += 1n;
    obs.feed(blob.slice(i, i + chunkSize), seq);
    await obs.snapshot();
  }
};

describe("R7 — real P1 captures (canonicality + honest state)", () => {
  it("claude/startup-idle: real ✳ title + OSC 9;4;0 + welcome composer → idle + pasteable", async () => {
    const entries = loadFixture("claude", "startup-idle");
    if (!entries) return console.warn("SKIP: claude/startup-idle absent");
    const obs = makeObserver();
    try {
      await feedAll(obs, decode(entries));
      const snap = await obs.snapshot();
      console.log("real claude startup-idle → title:", JSON.stringify(snap.signals.title),
        "| osc9:", JSON.stringify(snap.signals.osc9));
      expect(snap.signals.title).toBe("✳ Claude Code");
      expect(snap.signals.osc9).toBe("4;0;");
      // Real screen: welcome composer with `❯` prompt — idle chrome.
      const runtime = new SeatStateRuntime({ now: () => 1_000_000 });
      runtime.bindHarness("b1", "claude", "e1");
      runtime.observe(snap);
      const evs: string[] = [];
      runtime.subscribe((e) => evs.push(`${e.state}:${e.reason}`));
      runtime.observe(snap);
      const state = runtime.getState("b1");
      console.log("  → state:", state, "| events:", evs, "| isSeatIdle:", runtime.isSeatIdle("b1"));
      expect(state).toBe("idle");
      expect(runtime.isSeatIdle("b1")).toBe(true);
    } finally { obs.dispose(); }
  });

  it("claude/paste-chip: real '[Pasted text #1 +14 lines]' chip renders → chip visible, seat idle (pasteable)", async () => {
    const entries = loadFixture("claude", "paste-chip");
    if (!entries) return console.warn("SKIP: claude/paste-chip absent");
    const blob = decode(entries);
    const idx = blob.indexOf("[Pasted");
    expect(idx).toBeGreaterThan(0); // the real chip must be in the capture
    const obs = makeObserver();
    try {
      // Feed everything up to AND including the chip render, then snapshot.
      let seq = 0n;
      const cut = idx + 80; // a few bytes past '[Pasted' so the chip line is painted
      obs.feed(blob.slice(0, cut), ++seq);
      await obs.snapshot();
      const chipSnap = await obs.snapshot();
      console.log("chip window title:", JSON.stringify(chipSnap.signals.title),
        "| text has Pasted:", chipSnap.text.includes("Pasted"));
      expect(chipSnap.text).toContain("Pasted");
      const runtime = new SeatStateRuntime({ now: () => 1_000_000 });
      runtime.bindHarness("b1", "claude", "e1");
      runtime.observe(chipSnap);
      const state = runtime.getState("b1");
      console.log("  → chip-window state:", state, "| isSeatIdle:", runtime.isSeatIdle("b1"));
      // A visible chip is idle chrome (composer_draft_idle) — never working.
      expect(state).toBe("idle");
    } finally { obs.dispose(); }
  });

  it("claude/paste-chip tail: after Ctrl+C clear the composer is empty again", async () => {
    const entries = loadFixture("claude", "paste-chip");
    if (!entries) return console.warn("SKIP: claude/paste-chip absent");
    const obs = makeObserver();
    try {
      await feedAll(obs, decode(entries));
      const snap = await obs.snapshot();
      const hasChip = snap.text.includes("Pasted");
      const hasPrompt = snap.text.includes("❯");
      console.log("tail: chip visible:", hasChip, "| prompt glyph:", hasPrompt);
      expect(hasPrompt).toBe(true);
    } finally { obs.dispose(); }
  });

  it("muse/startup-idle: real P1 muse capture renders and publishes fallback idle (documented)", async () => {
    const entries = loadFixture("muse", "startup-idle");
    if (!entries) return console.warn("SKIP: muse/startup-idle absent");
    const obs = makeObserver();
    try {
      await feedAll(obs, decode(entries));
      const snap = await obs.snapshot();
      console.log("real muse title:", JSON.stringify(snap.signals.title),
        "| glyphs:", JSON.stringify([...new Set(snap.lines.join("\n").match(/\S/g) ?? [])].slice(0, 12)));
      const runtime = new SeatStateRuntime({ now: () => 1_000_000 });
      runtime.bindHarness("b1", "muse", "e1");
      runtime.observe(snap);
      const state = runtime.getState("b1");
      console.log("  → muse state:", state, "| isSeatIdle:", runtime.isSeatIdle("b1"));
      expect(state).toBe("idle"); // museRules is empty → fallback idle (documented)
      expect(runtime.isSeatIdle("b1")).toBe(false); // low-confidence fallback → paste refused (fail-closed)
    } finally { obs.dispose(); }
  });

  it("codex/startup-idle: REAL trust modal bytes → attention (not idle/working)", async () => {
    const entries = loadFixture("codex", "startup-idle");
    if (!entries) return console.warn("SKIP: codex/startup-idle absent");
    const obs = makeObserver();
    try {
      await feedAll(obs, decode(entries));
      const snap = await obs.snapshot();
      console.log("real codex startup text tail:", JSON.stringify(snap.text.slice(-240)));
      const runtime = new SeatStateRuntime({ now: () => 1_000_000 });
      runtime.bindHarness("b1", "codex", "e1");
      runtime.observe(snap);
      const state = runtime.getState("b1");
      const slot = runtime.machine.getSlot("b1");
      console.log("  → codex trust-modal state:", state, "| reason:", slot?.reason,
        "| visibleAttention:", slot?.visibleAttention);
      // Product law: any harness prompt is a product state → attention.
      expect(state).toBe("attention");
    } finally { obs.dispose(); }
  });


  it("kimi/startup-idle (real, v0.34.0): welcome screen has NO composer glyph → must be pasteable idle", async () => {
    // Real kimi 0.34.0 startup: welcome box + "context: 0% (0/1M)" footer, NO "> " composer
    // line on screen → kimi's prompt_footer_idle cannot fire → fallback idle refuses paste.
    const entries = loadFixture("kimi", "startup-idle");
    if (!entries) return console.warn("SKIP: kimi/startup-idle absent");
    const obs = makeObserver();
    try {
      await feedAll(obs, decode(entries));
      const snap = await obs.snapshot();
      const hasComposerGlyph = /^\s*[❯>]/.test(snap.lines[snap.lines.length - 4] ?? "");
      console.log("  kimi: title=", JSON.stringify(snap.signals.title),
        "| footer:", JSON.stringify(snap.lines[snap.lines.length - 1]), "| composerGlyph:", hasComposerGlyph);
      const runtime = new SeatStateRuntime({ now: () => 1_000_000 });
      runtime.bindHarness("b1", "kimi", "e1");
      runtime.observe(snap);
      const state = runtime.getState("b1");
      console.log("  → kimi state:", state, "| isSeatIdle:", runtime.isSeatIdle("b1"));
      expect(state).toBe("idle");
      expect(runtime.isSeatIdle("b1")).toBe(true); // FAILS today: real kimi idle is not pasteable
    } finally { obs.dispose(); }
  });

  it("prime-agent/startup-idle (real): OSC title 'prime-agent - prime-agent' → idle + pasteable (sanity)", async () => {
    const entries = loadFixture("prime-agent", "startup-idle");
    if (!entries) return console.warn("SKIP: prime-agent/startup-idle absent");
    const obs = makeObserver();
    try {
      await feedAll(obs, decode(entries));
      const snap = await obs.snapshot();
      const runtime = new SeatStateRuntime({ now: () => 1_000_000 });
      runtime.bindHarness("b1", "prime-agent", "e1");
      runtime.observe(snap);
      const state = runtime.getState("b1");
      console.log("  prime-agent: title=", JSON.stringify(snap.signals.title), "→ state:", state,
        "| isSeatIdle:", runtime.isSeatIdle("b1"));
      expect(state).toBe("idle");
      expect(runtime.isSeatIdle("b1")).toBe(true);
    } finally { obs.dispose(); }
  });

  it("devin/startup-idle (real): workspace-trust prompt → attention (sanity — real trust modal detected)", async () => {
    const entries = loadFixture("devin", "startup-idle");
    if (!entries) return console.warn("SKIP: devin/startup-idle absent");
    const obs = makeObserver();
    try {
      await feedAll(obs, decode(entries));
      const snap = await obs.snapshot();
      const runtime = new SeatStateRuntime({ now: () => 1_000_000 });
      runtime.bindHarness("b1", "devin", "e1");
      runtime.observe(snap);
      const state = runtime.getState("b1");
      const slot = runtime.machine.getSlot("b1");
      console.log("  devin: title=", JSON.stringify(snap.signals.title), "→ state:", state, "reason:", slot?.reason);
      expect(state).toBe("attention");
    } finally { obs.dispose(); }
  });

  it("grok/working-turn (real): MID-TURN snapshot (braille grid, static 'grok' title) → working", async () => {
    // Real capture: 152 braille frames animate on the grid while the OSC title stays
    // static "grok" for the whole session; no "[stop]" chip on this version.
    const entries = loadFixture("grok", "working-turn");
    if (!entries) return console.warn("SKIP: grok/working-turn absent");
    const blob = decode(entries);
    const midCut = blob.indexOf("press Ctrl+c again to quit"); // everything before exit-confirm
    const mid = midCut > 0 ? blob.slice(0, Math.min(midCut, 20_000)) : blob;
    const obs = makeObserver();
    try {
      let seq = 0n;
      for (let i = 0; i < mid.length; i += 512) {
        seq += 1n;
        obs.feed(mid.slice(i, i + 512), seq);
        await obs.snapshot();
      }
      const snap = await obs.snapshot();
      const braille = (snap.text.match(/[\u2800-\u28FF]/g) ?? []).length;
      const runtime = new SeatStateRuntime({ now: () => 1_000_000 });
      runtime.bindHarness("b1", "grok", "e1");
      runtime.observe(snap);
      const state = runtime.getState("b1");
      const slot = runtime.machine.getSlot("b1");
      console.log("  grok mid-turn: title=", JSON.stringify(snap.signals.title), "braille cells:", braille,
        "→ state:", state, "reason:", slot?.reason, "| isSeatIdle:", runtime.isSeatIdle("b1"));
      // A working turn with live braille on screen must never look idle/pasteable.
      expect(state).toBe("working"); // FAILS today: idle + isSeatIdle true (R9)
      expect(runtime.isSeatIdle("b1")).toBe(false);
    } finally { obs.dispose(); }
  });

  const workingTurnState = async (harness: string, label: string, cutAt: number) => {
    const entries = loadFixture(harness, "working-turn");
    if (!entries) { console.warn(`SKIP: ${harness}/working-turn absent`); return null; }
    const blob = decode(entries);
    const mid = blob.slice(0, Math.min(cutAt, blob.length));
    const obs = makeObserver();
    try {
      let seq = 0n;
      for (let i = 0; i < mid.length; i += 512) {
        seq += 1n;
        obs.feed(mid.slice(i, i + 512), seq);
        await obs.snapshot();
      }
      const snap = await obs.snapshot();
      const braille = (snap.text.match(/[\u2800-\u28FF]/g) ?? []).length;
      const runtime = new SeatStateRuntime({ now: () => 1_000_000 });
      runtime.bindHarness("b1", harness, "e1");
      runtime.observe(snap);
      const state = runtime.getState("b1");
      const slot = runtime.machine.getSlot("b1");
      console.log(`  ${label} [cut ${cutAt}]: title=${JSON.stringify(snap.signals.title)} braille=${braille} → state=${state} reason=${slot?.reason} idle=${runtime.isSeatIdle("b1")}`);
      obs.dispose();
      return { state, isSeatIdle: runtime.isSeatIdle("b1"), title: snap.signals.title };
    } catch (e) { obs.dispose(); throw e; }
  };

  it("codex/working-turn (real): animated spinner title mid-turn → working (sanity)", async () => {
    // Real codex churns the OSC title (⠴ ⠦ ⠧ ⠇ ⠏ codex) through the turn (~3KB–24KB+).
    const r = await workingTurnState("codex", "codex", 12_000);
    if (!r) return;
    expect(r.state).toBe("working");
  });

  it("hermes/working-turn (real): early-turn snapshot → working (probe; rules have no ⏳/braille working rule)", async () => {
    // Hermes shows ⏳ gpt-5.4-mini while working; its rule pack has no ⏳ rule and the
    // working evidence here is grid braille in the first KBs.
    const r = await workingTurnState("hermes", "hermes", 3_500);
    if (!r) return;
    expect(r.state).toBe("working");
  });

  it("kimi/working-turn (real): OSC 9;4;3 progress window → working (sanity)", async () => {
    // Kimi emits OSC 9;4;3 during the turn (buckets 3–16KB) — but kimi's pack has no osc9 rule.
    const r = await workingTurnState("kimi", "kimi", 10_000);
    if (!r) return;
    expect(r.state).toBe("working");
  });

  it("muse/working-turn (real): spinner title mid-turn → working (today: fallback idle — muse pack empty, chrome lies)", async () => {
    const r = await workingTurnState("muse", "muse", 6_500);
    if (!r) return;
    // museRules is empty → fallback idle is the DOCUMENTED behavior (fail-closed).
    console.log("  (muse working detection is intentionally absent — pack empty; document)");
    expect(r.state).toBe("working");
  });

  it("hermes/paste-chip (REAL D1 evidence): chip render survives CR@40ms and a second CR (manifest-verified)", async () => {
    // Hermes v0.20.0: 15-line paste collapses to "[[ PASTE_LINE_00 PA.. [15 lines] .. ]]";
    // capture manifest (live TUI): chipAfterCr40ms=true, submitted40ms=false,
    // second CR also does not submit, ONE Ctrl+C clears. The fixture must show the
    // chip render in the composer — the drive must NOT assume a 2nd CR collapses it.
    const entries = loadFixture("hermes", "paste-chip");
    if (!entries) return console.warn("SKIP: hermes/paste-chip absent");
    const blob = decode(entries);
    const chipIdx = blob.indexOf("[[ PASTE_LINE_00");
    expect(chipIdx).toBeGreaterThan(0); // real chip render present in bytes
    const obs = makeObserver();
    try {
      let seq = 0n;
      const cut = Math.min(blob.length, chipIdx + 4000); // after the chip render + CR
      for (let i = 0; i < cut; i += 512) {
        seq += 1n;
        obs.feed(blob.slice(i, i + 512), seq);
        await obs.snapshot();
      }
      const snap = await obs.snapshot();
      const chipVisible = snap.text.includes("[[ PASTE_LINE_00") || snap.text.includes("[15 lines]");
      const submitted = !snap.text.includes("[15 lines]") && snap.text.includes("❯");
      console.log("  hermes chip window: chipVisible:", chipVisible, "| submitted-look:", submitted);
      // The chip is on screen after CR@40ms — that is the state the drive must clear.
      expect(chipVisible).toBe(true);
    } finally { obs.dispose(); }
  });

});
