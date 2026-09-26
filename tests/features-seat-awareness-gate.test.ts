/**
 * The seat-awareness product gate, across the three feature tiers.
 *
 * One gate covers the whole subsystem: the advisory sidecar, the hover that
 * paints its judgment, the peer-help request and its thread, and the AI hold on
 * the delivery gate. The ship profile carries it EXPERIMENTAL: compiled in, off
 * until the operator turns it on in Settings, Experimental. `JUNTO_SEAT_AWARENESS`
 * takes 0 (compiled out), 1 (on) or experimental.
 *
 * Every consumer reads the one resolved predicate, so the tier alone never
 * turns anything on: that is what the source checks below hold.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveBuildFeatures } from "../scripts/build-features";
import { featureTierOn } from "../src/shared/feature-catalog";
import {
  SEAT_AWARENESS_COMPILED,
  SEAT_AWARENESS_TIER,
  seatAwarenessOn,
} from "../src/shared/features";
import { makeSeatAwarenessPlane } from "../src/main/junto/term/seat-awareness";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = (path: string): string => readFileSync(join(root, path), "utf8");

describe("seat awareness product gate", () => {
  it("ships experimental, is on in all-on, and takes every tier as an override", () => {
    expect(resolveBuildFeatures({}).features.seatAwareness).toBe("experimental");
    expect(resolveBuildFeatures({ JUNTO_FEATURE_PROFILE: "all-on" }).features.seatAwareness).toBe(true);
    expect(resolveBuildFeatures({ JUNTO_SEAT_AWARENESS: "1" }).features.seatAwareness).toBe(true);
    expect(resolveBuildFeatures({ JUNTO_SEAT_AWARENESS: "0" }).features.seatAwareness).toBe(false);
    expect(
      resolveBuildFeatures({
        JUNTO_FEATURE_PROFILE: "all-on",
        JUNTO_SEAT_AWARENESS: "experimental",
      }).features.seatAwareness,
    ).toBe("experimental");
  });

  it("resolves compiled && (tier on || operator enabled)", () => {
    expect(featureTierOn(false, true)).toBe(false);
    expect(featureTierOn(false, false)).toBe(false);
    expect(featureTierOn("experimental", false)).toBe(false);
    expect(featureTierOn("experimental", true)).toBe(true);
    expect(featureTierOn(true, false)).toBe(true);
    expect(featureTierOn(true, true)).toBe(true);
  });

  it("reads this build's tier through the one predicate", () => {
    expect(seatAwarenessOn(undefined)).toBe(SEAT_AWARENESS_TIER === true);
    expect(seatAwarenessOn({})).toBe(SEAT_AWARENESS_TIER === true);
    expect(seatAwarenessOn({ seatAwareness: false })).toBe(SEAT_AWARENESS_TIER === true);
    expect(seatAwarenessOn({ seatAwareness: true })).toBe(SEAT_AWARENESS_COMPILED);
    // Another feature's toggle is not this one's.
    expect(seatAwarenessOn({ reviews: true })).toBe(SEAT_AWARENESS_TIER === true);
  });

  it("gates every surface on the resolved predicate, never the tier", () => {
    const textNode = source("src/renderer/components/nodes/TextNode.tsx");
    expect(textNode).toContain("const seatNode = seatAwarenessOn && (managedTerminal || isAgent);");
    expect(textNode).toContain("useSeatAwarenessOn()");
    const ipc = source("src/main/junto/ipc.ts");
    expect(ipc).toContain("if (!seatAwarenessPlane.isEnabled()) {");
    expect(ipc).toContain("settingsForSeed.subscribe(applySeatAwareness);");
    expect(source("src/renderer/lib/seat-awareness.ts")).toContain(
      "if (!seatAwarenessOnNow()) return;",
    );
    // The retired Advanced opt-out has no surface any more.
    expect(source("src/renderer/components/SettingsPanel.tsx")).not.toContain(
      "advanced.seatAwareness",
    );
  });

  it.runIf(!SEAT_AWARENESS_COMPILED)(
    "compiled out: the sidecar constructs nothing and publishes nothing",
    () => {
      const plane = makeSeatAwarenessPlane();
      let calls = 0;
      plane.start({
        enabled: true,
        apiKey: "sk-not-used",
        plane: {
          subscribeAll: () => {
            calls += 1;
            return () => undefined;
          },
          readWindowNow: () => undefined,
        } as never,
      });
      expect(calls).toBe(0);
      expect(plane.isEnabled()).toBe(false);
      expect(plane.currentEvents()).toEqual([]);
    },
  );

  it.runIf(SEAT_AWARENESS_COMPILED)(
    "compiled in: a started plane runs, and stopping it forgets every reading",
    () => {
      const plane = makeSeatAwarenessPlane();
      let subscribed = 0;
      plane.start({
        enabled: true,
        apiKey: undefined,
        plane: {
          subscribeAll: () => {
            subscribed += 1;
            return () => undefined;
          },
          readWindowNow: () => undefined,
        } as never,
      });
      expect(subscribed).toBe(1);
      expect(plane.isEnabled()).toBe(true);
      plane.stop();
      expect(plane.isEnabled()).toBe(false);
      expect(plane.currentEvents()).toEqual([]);
    },
  );
});
