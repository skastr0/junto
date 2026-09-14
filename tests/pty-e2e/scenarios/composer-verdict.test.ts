/**
 * Composer verdict against REAL captures — the grounding gate for the
 * screen-truth typing gate (agent-state/composer.ts).
 *
 * Replays each shipped harness's P1 corpus through a REAL SessionObserver in
 * fine chunks and asserts the product law end-to-end on real bytes:
 *  - startup-idle settles to verdict "empty" (the placeholder hint must
 *    read as an empty box);
 *  - type-echo passes through at least one "draft" frame (typed text on
 *    screen refuses factory typing) and settles back to "empty" after the
 *    submission attempt.
 * Composer contents do not prove readiness: Hermes/Kimi captures contain
 * setup failures. composer-readiness.test.ts separately refuses their real
 * blocked frames through the shared destination drive.
 *
 * A harness failing here means its composer probes no longer match its real
 * chrome — factory typing into its seats is refusing (fail closed), and the
 * probes need re-grounding against a fresh capture.
 */
import { describe, expect, it } from "vitest";
import { loadP1Fixture } from "../runner";
import { SessionObserver } from "../../../src/main/vellum-command/term/observer";
import { composerVerdictForHarness } from "../../../src/main/vellum-command/term/agent-state";
import type { ComposerVerdict } from "../../../src/main/vellum-command/term/agent-state";

const CHUNK = 64;
// macOS Verify runs vitest at the default 5s test timeout on 2 workers;
// every 64-byte chunk gets a snapshot + verdict evaluation (~1ms each), so
// 200KB+ captures need an explicit budget. 15s covers ~3x the slowest
// observed local replay (amp/paste-chip ~4.2s) under CI contention.
const REPLAY_TIMEOUT_MS = 15_000;

const replay = async (
  harness: string,
  events: ReadonlyArray<{ readonly b64: string }>,
  chunk = CHUNK,
): Promise<{ draftFrames: number; final: ComposerVerdict }> => {
  const obs = new SessionObserver({
    bindingId: "b",
    epoch: "e",
    cols: 120,
    rows: 32,
  });
  let seq = 0n;
  let draftFrames = 0;
  let final: ComposerVerdict = null;
  try {
    for (const ev of events) {
      const data = Buffer.from(ev.b64, "base64").toString("utf8");
      for (let off = 0; off < data.length; off += chunk) {
        obs.feed(data.slice(off, off + chunk), seq++);
        const snapshot = await obs.snapshot();
        const verdict = composerVerdictForHarness(snapshot, harness);
        if (verdict === "draft") draftFrames += 1;
        final = verdict;
      }
    }
  } finally {
    obs.dispose();
  }
  return { draftFrames, final };
};

describe("amp composer verdict on real bytes", () => {
  it("startup-idle settles to empty (blank ruled box)", async () => {
    const fixture = loadP1Fixture("amp", "startup-idle");
    expect(fixture, "amp/startup-idle corpus missing").not.toBeNull();
    // Logo animation is 16 full-ish redraws; 64-byte chunks time out.
    const run = await replay("amp", fixture!.events, 1024);
    expect(run.final).toBe("empty");
  }, REPLAY_TIMEOUT_MS);

  it("paste-chip shows a draft frame (payload in the box)", async () => {
    const fixture = loadP1Fixture("amp", "paste-chip");
    expect(fixture, "amp/paste-chip corpus missing").not.toBeNull();
    const run = await replay("amp", fixture!.events);
    expect(run.draftFrames).toBeGreaterThan(0);
  }, REPLAY_TIMEOUT_MS);
});

for (const harness of ["claude", "codex", "grok", "pi", "devin", "muse", "hermes", "kimi", "omp"] as const) {
  describe(`${harness} composer verdict on real bytes`, () => {
    it("startup-idle settles to an empty composer", async () => {
      const fixture = loadP1Fixture(harness, "startup-idle");
      expect(fixture, `${harness}/startup-idle corpus missing`).not.toBeNull();
      const run = await replay(harness, fixture!.events);
      expect(
        run.final,
        `${harness} idle screen must prove an EMPTY composer or first-spawn delivery holds forever`,
      ).toBe("empty");
    }, REPLAY_TIMEOUT_MS);

    it("type-echo shows a draft frame, then returns to an empty composer", async () => {
      const fixture = loadP1Fixture(harness, "type-echo");
      expect(fixture, `${harness}/type-echo corpus missing`).not.toBeNull();
      const run = await replay(harness, fixture!.events);
      expect(
        run.draftFrames,
        `${harness} typed text never read as draft — an operator draft would be pasted over and submitted`,
      ).toBeGreaterThan(0);
      expect(
        run.final,
        `${harness} post-turn screen must return to EMPTY or delivery never resumes`,
      ).toBe("empty");
    }, REPLAY_TIMEOUT_MS);
  });
}
