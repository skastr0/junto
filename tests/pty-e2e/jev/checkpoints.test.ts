/**
 * Checkpoint + label manifest contract.
 *
 * The manifest is the evaluation's reference. These legs assert that it is
 * reproducible from the committed corpus, that every checkpoint was selected
 * from a RENDERED screen (never from a model or a rule verdict), that geometry
 * came from the capture's own manifest, and that the held-out split is disjoint
 * from the parent's paid runs.
 *
 * The drift leg replays the whole corpus (~30s). Scope it while iterating with
 * `JEV_DRIFT_HARNESSES=claude,grok`, which narrows both the rebuild and the
 * comparison.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { corpusRoot } from "../runner";
import { HARNESSES, probesFor } from "./chrome";
import { buildManifest, serializeManifest, withGeometry } from "./checkpoints";
import { HOLDOUT_CAPTURES, HOLDOUT_HARNESSES, PAID_CAPTURES, assertHoldoutDisjoint } from "./holdout";
import { loadManifest, manifestPath } from "./manifest-file";
import { MAX_CANDIDATE_LINES } from "./evidence";
import { captureGeometry } from "./replay";
import type { CheckpointClass } from "./types";

const CLASSES: readonly CheckpointClass[] = ["live_turn", "dialog", "settled_idle"];

const manifest = loadManifest();

describe("JEVC — manifest structure", () => {
  it("JEVC-shape: every harness with captures is represented, and captures match the corpus", () => {
    const files = HARNESSES.flatMap((harness) =>
      readdirSync(join(corpusRoot(), harness))
        .filter((file) => file.endsWith(".jsonl"))
        .map((file) => `${harness}/${file.replace(/\.jsonl$/u, "")}`),
    );
    expect(manifest.captures).toBe(files.length);
    expect(manifest.harnesses).toEqual([...HARNESSES]);
    const covered = new Set(manifest.checkpoints.map((c) => `${c.harness}/${c.scenario}`));
    // A capture with no selected checkpoint is allowed only when the harness's
    // chrome never paints in it — but every harness must contribute at least one.
    for (const harness of HARNESSES) {
      expect(
        manifest.checkpoints.some((c) => c.harness === harness),
        `${harness} contributed no checkpoint at all — its chrome declarations are ungrounded`,
      ).toBe(true);
    }
    expect(covered.size).toBeGreaterThan(0);
  });

  it("JEVC-select: every checkpoint was selected by a chrome match on the rendered screen", () => {
    for (const checkpoint of manifest.checkpoints) {
      expect(checkpoint.matches.length, `${checkpoint.id} has no chrome match`).toBeGreaterThan(0);
      expect(
        CLASSES.includes(checkpoint.class),
        `${checkpoint.id} has unknown class ${checkpoint.class}`,
      ).toBe(true);
      // The class must be the top-priority role among the matches, never a
      // value that no probe supports.
      const roles = new Set(checkpoint.matches.map((m) => m.role));
      expect(roles.has(checkpoint.class), `${checkpoint.id} class ${checkpoint.class} not in matches`).toBe(true);
      // A dialog checkpoint must name the concern it answers, or it grounds nothing.
      if (checkpoint.class === "dialog") {
        expect(
          checkpoint.matches.some((m) => m.role === "dialog"),
          `${checkpoint.id} is class dialog with no dialog-role match`,
        ).toBe(true);
      }
      for (const match of checkpoint.matches) {
        expect(match.probeId.length).toBeGreaterThan(0);
        expect(match.matchedText.length).toBeGreaterThan(0);
      }
    }
  });

  it("JEVC-geometry: geometry is the capture's own manifest value, never a default", () => {
    const cache = new Map<string, ReturnType<typeof captureGeometry>>();
    for (const checkpoint of manifest.checkpoints) {
      const geometry = cache.get(checkpoint.harness) ?? captureGeometry(checkpoint.harness);
      cache.set(checkpoint.harness, geometry);
      expect(checkpoint.geometry, checkpoint.id).toEqual(geometry);
      expect(checkpoint.geometry.source).toContain("manifest.json pty.cols/pty.rows");
      expect(checkpoint.geometry.cols).toBeGreaterThan(0);
      expect(checkpoint.geometry.rows).toBeGreaterThan(0);
    }
  });

  it("JEVC-window: the offered window is the bottom grid, id-tagged, capped at 128", () => {
    for (const checkpoint of manifest.checkpoints) {
      expect(checkpoint.window.candidateLines).toBeGreaterThan(0);
      expect(checkpoint.window.candidateLines).toBeLessThanOrEqual(MAX_CANDIDATE_LINES);
      expect(checkpoint.window.totalLines).toBeLessThanOrEqual(checkpoint.geometry.rows);
      expect(checkpoint.window.firstId).toBe("L000");
      expect(checkpoint.window.lastId).toBe(`L${String(checkpoint.window.candidateLines - 1).padStart(3, "0")}`);
    }
  });

  it("JEVC-cut: cuts are inside the capture, distinct, and anchored to the same decoded stream", () => {
    // Entries are emitted grouped by semantic signature (first cut, then last
    // cut), so the file order is not globally increasing. What must hold is
    // that every cut is inside the capture and no cut is sampled twice.
    const seenCuts = new Map<string, Set<number>>();
    const decodedByCapture = new Map<string, number>();
    for (const checkpoint of manifest.checkpoints) {
      expect(checkpoint.cut).toBeGreaterThan(0);
      expect(checkpoint.cut).toBeLessThanOrEqual(checkpoint.decodedLength);
      expect(checkpoint.cutFraction).toBeGreaterThan(0);
      expect(checkpoint.cutFraction).toBeLessThanOrEqual(1);
      expect(checkpoint.occurrences).toBeGreaterThanOrEqual(1);
      const key = `${checkpoint.harness}/${checkpoint.scenario}`;
      const cuts = seenCuts.get(key) ?? new Set<number>();
      expect(cuts.has(checkpoint.cut), `${key} samples cut ${checkpoint.cut} twice`).toBe(false);
      cuts.add(checkpoint.cut);
      seenCuts.set(key, cuts);
      const prior = decodedByCapture.get(key);
      if (prior !== undefined) expect(checkpoint.decodedLength).toBe(prior);
      decodedByCapture.set(key, checkpoint.decodedLength);
    }
    expect(seenCuts.size).toBeGreaterThan(0);
  });

  it("JEVC-label: every label carries a grounded value or an explicit abstention with a reason", () => {
    const axes = [
      "activity",
      "turn_in_progress",
      "approval_requested",
      "answer_requested",
      "access_problem",
      "execution_error",
      "repetition",
      "highlight_exists",
      "highlight_line",
    ] as const;
    for (const checkpoint of manifest.checkpoints) {
      for (const axis of axes) {
        const label = checkpoint.labels[axis];
        expect(label.value.length, `${checkpoint.id}.${axis} has no value`).toBeGreaterThan(0);
        expect(label.basis.length, `${checkpoint.id}.${axis} has no basis`).toBeGreaterThan(10);
        if (label.value === "insufficient_evidence") {
          expect(label.literal, `${checkpoint.id}.${axis} abstained but carries a literal`).toBeUndefined();
        }
      }
      // highlight_line must be NONE, an id inside the offered window, or an abstention.
      const hl = checkpoint.labels.highlight_line.value;
      if (hl !== "NONE" && hl !== "insufficient_evidence") {
        expect(
          /^L\d{3}$/u.test(hl) && Number(hl.slice(1)) < checkpoint.window.candidateLines,
          `${checkpoint.id} highlight_line ${hl} is outside the offered window`,
        ).toBe(true);
      }
      if (checkpoint.labels.highlight_exists.value === "no") {
        expect(checkpoint.labels.highlight_line.value, `${checkpoint.id}`).toBe("NONE");
      }
    }
  });

  it("JEVC-coverage: declared probes are either observed or recorded as unobserved", () => {
    const observed = new Set(manifest.checkpoints.flatMap((c) => c.matches.map((m) => m.probeId)));
    const declared = HARNESSES.flatMap((harness) => probesFor(harness).map((probe) => probe.id));
    for (const id of declared) {
      const recorded = manifest.coverage.unobservedProbes.includes(id);
      expect(
        observed.has(id) || recorded,
        `${id} is declared but neither observed nor listed in coverage.unobservedProbes`,
      ).toBe(true);
      expect(
        observed.has(id) && recorded,
        `${id} is both observed and listed as unobserved`,
      ).toBe(false);
    }
  });

  it("JEVC-coverage: the gaps name what the corpus cannot ground, including claude's permission return", () => {
    const gaps = manifest.coverage.gaps;
    expect(gaps.length).toBeGreaterThan(0);
    const claudePermission = gaps.find((g) => g.harness === "claude" && g.scenario === "permission-returns-idle");
    expect(claudePermission, "claude has no permission-return capture — the gap must be recorded").toBeDefined();
    expect(claudePermission?.kind).toBe("declared-skip");
    expect(claudePermission?.reason.length).toBeGreaterThan(0);
    expect(claudePermission?.unblocks).toContain("approval_requested");
    for (const gap of gaps) {
      expect(gap.reason.length, `${gap.harness}/${gap.scenario} gap has no reason`).toBeGreaterThan(0);
      expect(gap.unblocks.length, `${gap.harness}/${gap.scenario} gap names no unblocked label`).toBeGreaterThan(0);
    }
    // A gap must be a scenario the corpus really lacks — a declared skip or an
    // absent row has no bytes; an undeclared capture has them but no manifest row.
    for (const gap of gaps) {
      const path = join(corpusRoot(), gap.harness, `${gap.scenario}.jsonl`);
      const hasFixture = existsSync(path);
      if (gap.kind === "undeclared-capture") {
        expect(hasFixture, `${gap.harness}/${gap.scenario} is undeclared but has no fixture`).toBe(true);
      } else {
        expect(
          hasFixture,
          `${gap.harness}/${gap.scenario} is recorded as ${gap.kind} but a fixture exists`,
        ).toBe(false);
      }
    }
  });

  it("JEVC-authority: no label is derived from a control-path value", () => {
    // The manifest must never carry a seat state, composer verdict, or
    // needsLook. Values are the pack's own vocabulary plus `insufficient_evidence`.
    const allowed = new Set([
      "yes",
      "no",
      "insufficient_evidence",
      "NONE",
      "investigating",
      "editing",
      "running_command",
      "testing",
      "reviewing",
      "reporting",
      "indeterminate",
    ]);
    for (const checkpoint of manifest.checkpoints) {
      for (const [axis, label] of Object.entries(checkpoint.labels)) {
        if (/^L\d{3}$/u.test(label.value)) continue;
        expect(allowed.has(label.value), `${checkpoint.id}.${axis} = ${label.value} is outside the pack vocabulary`).toBe(
          true,
        );
      }
    }
  });
});

describe("JEVC — held-out split", () => {
  it("JEVC-holdout: holdout and paid sets are disjoint and every holdout capture exists", () => {
    expect(() => assertHoldoutDisjoint()).not.toThrow();
    const paid = new Set<string>(PAID_CAPTURES);
    for (const key of [...HOLDOUT_CAPTURES, ...HOLDOUT_HARNESSES.map((h) => `${h}/startup-idle`)]) {
      expect(paid.has(key), `${key} is held out and paid`).toBe(false);
    }
  });

  it("JEVC-holdout: the holdout covers the label classes the tune set cannot test", () => {
    const byCapture = new Map<string, Set<string>>();
    for (const checkpoint of manifest.checkpoints) {
      const key = `${checkpoint.harness}/${checkpoint.scenario}`;
      const set = byCapture.get(key) ?? new Set<string>();
      set.add(checkpoint.class);
      byCapture.set(key, set);
    }
    const holdoutClasses = new Set(
      HOLDOUT_CAPTURES.flatMap((key) => [...(byCapture.get(key) ?? new Set<string>())]),
    );
    expect(holdoutClasses.has("dialog")).toBe(true);
    expect(holdoutClasses.has("settled_idle")).toBe(true);
    const paidClasses = new Set(PAID_CAPTURES.flatMap((key) => [...(byCapture.get(key) ?? new Set<string>())]));
    expect(paidClasses.has("live_turn")).toBe(true);
  });
});

describe("JEVC — reproducibility", () => {
  it(
    "JEVC-drift: rebuilding from the corpus reproduces the committed manifest byte for byte",
    async () => {
      const scope = process.env.JEV_DRIFT_HARNESSES;
      const harnesses = scope ? scope.split(",") : [...HARNESSES];
      const fresh = withGeometry(
        await buildManifest({ fractionSteps: manifest.steps.fraction, harnesses }),
        captureGeometry,
      );
      if (!scope) {
        expect(serializeManifest(fresh)).toBe(readFileSync(manifestPath(), "utf8"));
        return;
      }
      const committed = manifest.checkpoints.filter((c) => harnesses.includes(c.harness));
      expect(fresh.checkpoints).toEqual(committed);
    },
    180_000,
  );
});
