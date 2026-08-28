/**
 * Composer verdict against REAL captures — the grounding gate for the
 * screen-truth typing gate (agent-state/composer.ts).
 *
 * Replays each shipped harness's P1 corpus through a REAL SessionObserver in
 * fine chunks and asserts the product law end-to-end on real bytes:
 *  - startup-idle settles to verdict "empty" (a fresh seat is deliverable —
 *    the placeholder hint must read as an empty box, or first-spawn delivery
 *    holds forever);
 *  - type-echo passes through at least one "draft" frame (typed text on
 *    screen refuses factory typing) and settles back to "empty" after the
 *    turn (delivery resumes).
 *
 * A harness failing here means its composer probes no longer match its real
 * chrome — factory typing into its seats is refusing (fail closed), and the
 * probes need re-grounding against a fresh capture.
 */
import { describe, expect, it } from "vitest";
import { loadP1Fixture } from "../runner";
import { SessionObserver } from "../../../src/main/vellum/term/observer";
import { composerVerdictForHarness } from "../../../src/main/vellum/term/agent-state";
import type { ComposerVerdict } from "../../../src/main/vellum/term/agent-state";

const CHUNK = 64;

const replay = async (
  harness: string,
  events: ReadonlyArray<{ readonly b64: string }>,
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
      for (let off = 0; off < data.length; off += CHUNK) {
        obs.feed(data.slice(off, off + CHUNK), seq++);
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

for (const harness of ["claude", "codex", "grok", "pi", "devin"] as const) {
  describe(`${harness} composer verdict on real bytes`, () => {
    it("startup-idle settles to empty (fresh seat is deliverable)", async () => {
      const fixture = loadP1Fixture(harness, "startup-idle");
      expect(fixture, `${harness}/startup-idle corpus missing`).not.toBeNull();
      const run = await replay(harness, fixture!.events);
      expect(
        run.final,
        `${harness} idle screen must prove an EMPTY composer or first-spawn delivery holds forever`,
      ).toBe("empty");
    });

    it("type-echo shows a draft frame, then settles back to empty", async () => {
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
    });
  });
}
