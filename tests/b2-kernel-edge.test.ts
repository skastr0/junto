import { afterEach, describe, expect, it } from "vitest";
import type { EtherWatch } from "../src/shared/canvas";
import type { SnapshotState } from "../src/shared/entities";
import type { TowerGlyphRow } from "../src/shared/ipc";
import { evaluateWatcher, resetWatcherMemory, type GlyphIndex } from "../src/renderer/lib/kernel";
import { flagShouldToggle } from "../src/renderer/lib/kernel-state";

// --- fixtures ----------------------------------------------------------------

const EMPTY_SNAPSHOTS: SnapshotState = { bundles: [] };

const glyphRow = (overrides: Partial<TowerGlyphRow> & { glyphId: string; state: string }): TowerGlyphRow => ({
  orbit: "forge",
  title: "ship it",
  updatedAt: Date.now(),
  ...overrides,
});

const glyphIndexOf = (project: string, rows: ReadonlyArray<TowerGlyphRow>): GlyphIndex => new Map([[project, rows]]);

// An empty index means the source is down/absent for this project — evaluation
// degrades to "unknown" (the same state a slow tower/quasar fetch produces).
const SOURCE_DOWN: GlyphIndex = new Map();

afterEach(() => {
  resetWatcherMemory();
});

// --- BUG 1: unknown -> satisfied must not be a rising edge --------------------

describe("level watcher — recovery from an unknown source blip does not re-fire", () => {
  const watch: EtherWatch = { kind: "glyphs_done", project: "proj" };
  const allDone = glyphIndexOf("proj", [glyphRow({ glyphId: "g1", state: "done" })]);

  it("a satisfied -> unknown -> satisfied blip never manufactures a fresh fire", () => {
    // pass 1: already satisfied on first look -> baseline, never fires
    const baseline = evaluateWatcher("w1", watch, EMPTY_SNAPSHOTS, allDone);
    expect(baseline.state.status).toBe("satisfied");
    expect(baseline.fired).toBe(false);

    // pass 2: the source is briefly down -> unknown; must not fire, and must
    // not overwrite the "satisfied" baseline the recovery is compared against
    const blip = evaluateWatcher("w1", watch, EMPTY_SNAPSHOTS, SOURCE_DOWN);
    expect(blip.state.status).toBe("unknown");
    expect(blip.fired).toBe(false);

    // pass 3: source recovers, condition is still (unchanged) satisfied. The
    // bug fired here because `previous` had been clobbered to "unknown".
    const recovered = evaluateWatcher("w1", watch, EMPTY_SNAPSHOTS, allDone);
    expect(recovered.state.status).toBe("satisfied");
    expect(recovered.fired).toBe(false);
  });

  it("a genuine pending -> satisfied edge still fires even across an unknown blip", () => {
    const pending = glyphIndexOf("proj", [
      glyphRow({ glyphId: "g1", state: "done" }),
      glyphRow({ glyphId: "g2", state: "building" }),
    ]);
    const done = glyphIndexOf("proj", [
      glyphRow({ glyphId: "g1", state: "done" }),
      glyphRow({ glyphId: "g2", state: "done" }),
    ]);

    evaluateWatcher("w1", watch, EMPTY_SNAPSHOTS, pending); // baseline: pending
    const blip = evaluateWatcher("w1", watch, EMPTY_SNAPSHOTS, SOURCE_DOWN); // source down
    expect(blip.fired).toBe(false);
    // The awaited transition genuinely happened while (or after) the source was
    // down; the pending baseline survives the blip, so the edge still fires.
    const crossed = evaluateWatcher("w1", watch, EMPTY_SNAPSHOTS, done);
    expect(crossed.state.status).toBe("satisfied");
    expect(crossed.fired).toBe(true);
  });

  it("an unknown first observation is not a baseline, so the first real read cannot fire", () => {
    const first = evaluateWatcher("w1", watch, EMPTY_SNAPSHOTS, SOURCE_DOWN);
    expect(first.state.status).toBe("unknown");
    expect(first.fired).toBe(false);
    // First KNOWN observation is the baseline — satisfied here must not fire.
    const second = evaluateWatcher("w1", watch, EMPTY_SNAPSHOTS, allDone);
    expect(second.state.status).toBe("satisfied");
    expect(second.fired).toBe(false);
  });
});

// --- BUG 2: unknown must never mutate the document via flagOnUnsatisfied ------

describe("flagShouldToggle — unknown never touches the blocker flag", () => {
  it("leaves the flag untouched on an unknown read, whether or not a flag exists", () => {
    // The old rule was `status !== "satisfied"`, so unknown+no-flag toggled the
    // blocker ON (a document write on a down source) and unknown+flag toggled it
    // OFF — both violate the down-source invariant. Now: no change on unknown.
    expect(flagShouldToggle(false, "unknown")).toBe(false);
    expect(flagShouldToggle(true, "unknown")).toBe(false);
  });

  it("raises the blocker only on a KNOWN pending read", () => {
    expect(flagShouldToggle(false, "pending")).toBe(true); // raise
    expect(flagShouldToggle(true, "pending")).toBe(false); // already raised — no churn
  });

  it("clears the blocker only on a KNOWN satisfied read", () => {
    expect(flagShouldToggle(true, "satisfied")).toBe(true); // clear
    expect(flagShouldToggle(false, "satisfied")).toBe(false); // already clear — no churn
  });
});
