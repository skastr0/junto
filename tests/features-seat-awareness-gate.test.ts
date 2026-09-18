/**
 * The seat-awareness product gate.
 *
 * One gate covers the whole subsystem: the advisory sidecar, the hover that
 * paints its judgment, the peer-help request and its thread, and the AI hold on
 * the delivery gate. Ship profile off; `JUNTO_SEAT_AWARENESS=1` (or the all-on
 * profile) turns it on.
 *
 * Both directions are asserted here, and each half runs in the profile it
 * describes: `bun run test:features:ship` runs the off half, `bun run test`
 * (all-on) runs the on half.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveBuildFeatures } from "../scripts/build-features";
import { SEAT_AWARENESS_ENABLED } from "../src/shared/features";
import {
  makeSeatAwarenessPlane,
} from "../src/main/junto/term/seat-awareness";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = (path: string): string => readFileSync(join(root, path), "utf8");

describe("seat awareness product gate", () => {
  it("resolves off in the ship profile and on for the all-on profile", () => {
    expect(resolveBuildFeatures({}).features.seatAwareness).toBe(false);
    expect(resolveBuildFeatures({ JUNTO_FEATURE_PROFILE: "all-on" }).features.seatAwareness).toBe(true);
    expect(
      resolveBuildFeatures({ JUNTO_SEAT_AWARENESS: "1" }).features.seatAwareness,
    ).toBe(true);
    expect(
      resolveBuildFeatures({
        JUNTO_FEATURE_PROFILE: "all-on",
        JUNTO_SEAT_AWARENESS: "0",
      }).features.seatAwareness,
    ).toBe(false);
  });

  it.runIf(!SEAT_AWARENESS_ENABLED)(
    "ships dark: the sidecar constructs nothing and publishes nothing",
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

  it.runIf(!SEAT_AWARENESS_ENABLED)(
    "ships dark: no surface renders and the collaboration action refuses",
    () => {
      // The renderer gate is the overlay condition; the action gate is the
      // refusal in the IPC handler. Both are source-checked here because a
      // ship build is the only place they can be observed, and that build is
      // exactly what this suite runs in.
      expect(source("src/renderer/components/nodes/TextNode.tsx")).toContain(
        "SEAT_AWARENESS_ENABLED && (managedTerminal || isAgent)",
      );
      expect(source("src/main/junto/ipc.ts")).toContain(
        "seat collaboration is not enabled in this build",
      );
      expect(source("src/renderer/components/SettingsPanel.tsx")).toContain(
        "{SEAT_AWARENESS_ENABLED ? (",
      );
    },
  );

  it.runIf(SEAT_AWARENESS_ENABLED)(
    "the all-on profile restores the subsystem",
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
      plane.stop();
    },
  );
});
