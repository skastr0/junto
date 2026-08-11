/**
 * Per-harness classification against REAL captures.
 *
 * Scope: the five harnesses that are NOT behind a build flag
 * (src/shared/features.ts managedHarnessEnabled) — claude, codex, grok, pi,
 * devin. Four real scenarios each, from the canonical corpus at
 * tests/pty-e2e/corpus/<harness>/<scenario>.jsonl.
 *
 * Why this file exists: "reaches idle" proves nothing. engine.ts returns
 * state idle / confidence low / ruleId null / reason
 * default_known_agent_idle_fallback whenever a KNOWN harness matches NO rule,
 * so a suite that only checks `state === "idle"` passes on a screen the rules
 * never understood. Every leg here therefore asserts three things together:
 *
 *   1. the harness's OWN chrome literal is on the rendered screen (never a
 *      shared glyph class — ❯ › ❭ are different harnesses),
 *   2. the published state matches what that screen actually shows,
 *   3. the state came from a NAMED rule/hook, not the fallback.
 *
 * A missing corpus is a RED suite, never a skip (see requireCapture).
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SessionObserver } from "../../../src/main/vellum/term/observer";
import { SeatStateRuntime } from "../../../src/main/vellum/term/agent-state/runtime";
import { FALLBACK_IDLE } from "../../../src/main/vellum/term/agent-state/engine";
import {
  capturePath,
  captureDeclaration,
  requireCapture,
  type LoadedFixture,
} from "../runner";

/** The five non-flagged harnesses. */
const HARNESSES = ["claude", "codex", "grok", "pi", "devin"] as const;
type Harness = (typeof HARNESSES)[number];

/**
 * Per-harness screen chrome, read off the rendered captures — NOT guessed.
 * `idle` is that harness's own composer/footer literal; a shared glyph class
 * would pass for the wrong harness and is exactly the trap this avoids.
 * `working` is the harness's own mid-turn indicator; it must be a live
 * spinner/progress line, never a static footer hint (claude and pi both print
 * the word "interrupt" in their permanent shortcut footer).
 */
const CHROME: Record<Harness, { readonly idle: RegExp; readonly working: RegExp }> = {
  claude: { idle: /^\s*❯/mu, working: /\(\d+s[^)]*thinking\)/u },
  codex: { idle: /^\s*›/mu, working: /Working \(\d+s\s*•\s*esc to interrupt\)/u },
  grok: { idle: /^\s*❯/mu, working: /(Responding…|◆ Thinking…)/u },
  pi: { idle: /%\/400k \(auto\)/u, working: /·\s*\d+s\s*\(esc (?:twice )?to interrupt\)/u },
  devin: { idle: /^\s*❭/mu, working: /·\s*\d+s\s*\(esc (?:twice )?to interrupt\)/u },
};

const decode = (fixture: LoadedFixture): string =>
  fixture.events
    .map((e) => Buffer.from(e.b64, "base64").toString("utf8"))
    .join("");

type Classification = {
  readonly screen: string;
  readonly state: string;
  readonly reason: string;
  readonly confidence: string;
  readonly isSeatIdle: boolean;
};

/** Feed real bytes (optionally truncated) through the REAL observer + runtime. */
const classify = async (
  harness: Harness,
  blob: string,
  cut?: number,
): Promise<Classification> => {
  const obs = new SessionObserver({ bindingId: "b1", epoch: "e1", cols: 120, rows: 32 });
  const rt = new SeatStateRuntime({ now: () => 1_000_000 });
  try {
    const body = cut === undefined ? blob : blob.slice(0, cut);
    let seq = 0n;
    for (let i = 0; i < body.length; i += 512) {
      seq += 1n;
      obs.feed(body.slice(i, i + 512), seq);
      await obs.snapshot();
    }
    const snap = await obs.snapshot();
    rt.bindHarness("b1", harness, "e1");
    rt.observe(snap);
    const slot = rt.machine.getSlot("b1");
    return {
      screen: snap.lines.join("\n"),
      state: rt.getState("b1") ?? "unknown",
      reason: slot?.reason ?? "",
      confidence: slot?.confidence ?? "",
      isSeatIdle: rt.isSeatIdle("b1"),
    };
  } finally {
    rt.stop();
    obs.dispose();
  }
};

/**
 * Walk the capture and return EVERY truncation whose RENDERED screen shows the
 * harness's working chrome. Locating the cuts from the screen (rather than a
 * magic byte offset) is what makes the working legs honest: the screen is the
 * ground truth, the classifier is the thing under test.
 *
 * All of them, not just the first: a harness can classify the opening frame
 * correctly and then lose the turn to a higher-priority idle rule mid-flight,
 * which is precisely the mid-turn class that reaches production.
 */
const workingCuts = async (
  harness: Harness,
  blob: string,
  steps = 20,
): Promise<ReadonlyArray<{ readonly cut: number; readonly result: Classification }>> => {
  const hits: Array<{ cut: number; result: Classification }> = [];
  for (let i = 1; i <= steps; i += 1) {
    const cut = Math.floor((blob.length * i) / steps);
    const result = await classify(harness, blob, cut);
    if (CHROME[harness].working.test(result.screen)) hits.push({ cut, result });
  }
  return hits;
};

const load = (harness: Harness, scenario: string): LoadedFixture =>
  requireCapture(harness, scenario);

describe("HC — corpus contract (a missing capture is red, never a skip)", () => {
  for (const harness of HARNESSES) {
    it(`HC-corpus: ${harness} has all four real scenarios`, () => {
      for (const scenario of ["startup-idle", "type-echo", "paste-chip", "working-turn"]) {
        const declared = captureDeclaration(harness, scenario);
        if (declared?.status === "skip") {
          // A harness that CANNOT paint the screen is a reviewed absence, not
          // a gap — but it only counts when the committed manifest says so and
          // says why. An undeclared missing file still fails below.
          expect(
            declared.reason?.trim().length ?? 0,
            `${harness}/${scenario} is declared skip with no reason — an absence must justify itself`,
          ).toBeGreaterThan(0);
          continue;
        }
        const fixture = requireCapture(harness, scenario);
        expect(
          fixture.events.length,
          `${harness}/${scenario} resolved but carries no bytes (${capturePath(harness, scenario)})`,
        ).toBeGreaterThan(0);
      }
    });
  }
});

describe("HC — idle chrome publishes a NAMED idle (never the fallback)", () => {
  for (const harness of HARNESSES) {
    for (const scenario of ["startup-idle", "type-echo"] as const) {
      it(`HC-idle: ${harness}/${scenario} — own chrome on screen, idle from a real rule`, async () => {
        const blob = decode(load(harness, scenario));
        const r = await classify(harness, blob);

        // 1. The harness's OWN idle chrome really rendered.
        expect(
          CHROME[harness].idle.test(r.screen),
          `[${harness}/${scenario}] own idle chrome ${CHROME[harness].idle} not on the rendered screen`,
        ).toBe(true);

        // 2/3. Idle, and it came from a named rule/hook — not the fallback.
        expect(r.state, `[${harness}/${scenario}] state`).toBe("idle");
        expect(
          r.reason,
          `[${harness}/${scenario}] idle must come from a real rule, not ${FALLBACK_IDLE}`,
        ).not.toBe(FALLBACK_IDLE);
        expect(r.confidence, `[${harness}/${scenario}] confidence`).toBe("high");
        expect(r.isSeatIdle, `[${harness}/${scenario}] a named idle must be pasteable`).toBe(true);
      });
    }
  }
});

describe("HC — pasted payload is observable and never classified by the fallback", () => {
  for (const harness of HARNESSES) {
    it(`HC-paste: ${harness}/paste-chip — payload on screen, named classification`, async () => {
      const declared = captureDeclaration(harness, "paste-chip");
      if (declared?.status === "skip") {
        // pi is the live case: an 80-line bracketed paste painted neither the
        // payload nor a chip, so the corpus records the absence instead of
        // shipping bytes that prove nothing. Assert the declaration — the
        // claim is visible and falsifiable, never a silent pass.
        expect(
          declared.reason?.trim().length ?? 0,
          `[${harness}/paste-chip] declared skip must carry a reason`,
        ).toBeGreaterThan(0);
        expect(
          existsSync(capturePath(harness, "paste-chip")),
          `[${harness}/paste-chip] declared skip but bytes exist — declaration and corpus disagree`,
        ).toBe(false);
        return;
      }
      const blob = decode(load(harness, "paste-chip"));
      // The capture pastes PASTE_LINE_00..14. Somewhere in the stream the
      // harness must render it — expanded, or collapsed into its own chip.
      // If our text is not observable, the injection supervisor is blind
      // (POL-3) and no classification claim about this screen is meaningful.
      const rendered = await classify(harness, blob, Math.floor(blob.length * 0.5));
      const anywhere = rendered.screen + (await classify(harness, blob)).screen;
      expect(
        /PASTE_LINE_|\[Pasted|\[15 lines\]/u.test(anywhere),
        `[${harness}/paste-chip] pasted payload never rendered — capture cannot prove chip semantics`,
      ).toBe(true);

      const final = await classify(harness, blob);
      expect(
        final.reason,
        `[${harness}/paste-chip] classification fell back to ${FALLBACK_IDLE} — the rules never understood this screen`,
      ).not.toBe(FALLBACK_IDLE);
      expect(final.confidence, `[${harness}/paste-chip] confidence`).toBe("high");
    });
  }
});

describe("HC — a screen showing working chrome must classify working", () => {
  for (const harness of HARNESSES) {
    it(`HC-working: ${harness}/working-turn — mid-turn screen is working, not idle`, async () => {
      const declared = captureDeclaration(harness, "working-turn");
      if (declared?.status === "skip") {
        // Same reviewed-absence contract as paste-chip: the declaration is the
        // assertion, so it stays visible and falsifiable rather than silent.
        expect(
          declared.reason?.trim().length ?? 0,
          `[${harness}/working-turn] declared skip must carry a reason`,
        ).toBeGreaterThan(0);
        expect(
          existsSync(capturePath(harness, "working-turn")),
          `[${harness}/working-turn] declared skip but bytes exist — declaration and corpus disagree`,
        ).toBe(false);
        return;
      }
      const blob = decode(load(harness, "working-turn"));
      const hits = await workingCuts(harness, blob);

      // Corpus gate: a working-turn capture with no observable working chrome
      // cannot validate anything. Loud, and it names whose problem it is.
      expect(
        hits.length,
        `[${harness}/working-turn] no rendered screen in the capture shows working chrome ` +
          `${CHROME[harness].working} — the capture never recorded a visible turn (corpus defect, ` +
          `not a classifier verdict): ${capturePath(harness, "working-turn")}`,
      ).toBeGreaterThan(0);

      // Every screen that visibly shows the turn must classify as the turn.
      const wrong = hits.filter((h) => h.result.state !== "working");
      expect(
        wrong.map((h) => `@${h.cut} ${h.result.state}/${h.result.reason}`).join(", "),
        `[${harness}/working-turn] ${wrong.length}/${hits.length} screens show working chrome but ` +
          `did not classify working`,
      ).toBe("");

      // The paste gate is the product consequence: a working seat must refuse
      // injection. isSeatIdle true here means the drive would paste into a
      // running agent.
      const pasteable = hits.filter((h) => h.result.isSeatIdle);
      expect(
        pasteable.map((h) => `@${h.cut} ${h.result.reason}`).join(", "),
        `[${harness}/working-turn] ${pasteable.length}/${hits.length} mid-turn screens accept paste`,
      ).toBe("");

      // …and never by the fallback (a "known harness, no rule matched" verdict).
      const fellBack = hits.filter((h) => h.result.reason === FALLBACK_IDLE);
      expect(
        fellBack.map((h) => `@${h.cut}`).join(", "),
        `[${harness}/working-turn] ${fellBack.length}/${hits.length} mid-turn screens hit ${FALLBACK_IDLE}`,
      ).toBe("");
    });
  }
});
