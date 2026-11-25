// When the far badge's hover list opens and closes (shell/cluster-hover.ts):
// a short steady hover opens it; the badge or the list holds it; leaving both
// closes it after a grace; a dismissal closes it at once and that badge stays
// shut until the pointer has left it.

import { describe, expect, it } from "vitest";
import { CLUSTER_HOVER, createClusterHoverController, type ClusterTarget } from "../src/window/canvas/shell/cluster-hover";

const A: ClusterTarget = { key: "region:a", memberIds: ["a1", "a2"] };
const B: ClusterTarget = { key: "region:b", memberIds: ["b1"] };

const rig = () => {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const shown: Array<string | null> = [];
  const controller = createClusterHoverController({
    timers: {
      set: (run, ms) => {
        const id = next++;
        timers.set(id, { at: now + ms, run });
        return id;
      },
      clear: (handle) => void timers.delete(handle as number),
    },
    show: (target) => void shown.push(target?.key ?? null),
  });
  const advance = (ms: number): void => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((p, q) => p[1].at - q[1].at)[0];
      if (due === undefined) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].run();
    }
    now = end;
  };
  return { controller, advance, shown, pendingTimers: () => timers.size };
};

const { openMs, graceMs } = CLUSTER_HOVER;

describe("the far badge's hover list", () => {
  it("opens after a steady hover, not before", () => {
    const { controller, advance, shown } = rig();
    controller.pointer(A);
    advance(openMs - 1);
    expect(shown).toEqual([]);
    advance(1);
    expect(shown).toEqual(["region:a"]);
  });

  it("opens nothing for a pointer that sweeps over a badge and on", () => {
    const { controller, advance, shown, pendingTimers } = rig();
    controller.pointer(A);
    advance(openMs / 2);
    controller.pointer(null);
    advance(openMs * 4);
    expect(shown).toEqual([]);
    expect(pendingTimers()).toBe(0);
  });

  it("keeps its wait while the pointer moves on the same badge, and restarts it on another", () => {
    const { controller, advance, shown } = rig();
    controller.pointer(A);
    advance(openMs - 20);
    controller.pointer(A);
    advance(20);
    expect(shown).toEqual(["region:a"]);
    const second = rig();
    second.controller.pointer(A);
    second.advance(openMs - 20);
    second.controller.pointer(B);
    second.advance(20);
    expect(second.shown).toEqual([]);
    second.advance(openMs);
    expect(second.shown).toEqual(["region:b"]);
  });

  it("closes after a grace once the pointer leaves the badge, and not if it reaches the list in time", () => {
    const { controller, advance, shown } = rig();
    controller.pointer(A);
    advance(openMs);
    controller.pointer(null);
    advance(graceMs - 1);
    controller.panel(true);
    advance(graceMs * 4);
    expect(shown).toEqual(["region:a"]);
    controller.panel(false);
    advance(graceMs);
    expect(shown).toEqual(["region:a", null]);
  });

  it("stays open while the pointer is back on the badge after crossing the list", () => {
    const { controller, advance, shown } = rig();
    controller.pointer(A);
    advance(openMs);
    controller.pointer(null);
    controller.panel(true);
    controller.panel(false);
    controller.pointer(A);
    advance(graceMs * 4);
    expect(shown).toEqual(["region:a"]);
  });

  it("closes at once on a dismissal, and the badge stays shut until the pointer has left it", () => {
    const { controller, advance, shown } = rig();
    controller.pointer(A);
    advance(openMs);
    controller.dismiss();
    expect(shown).toEqual(["region:a", null]);
    controller.pointer(A);
    advance(openMs * 4);
    expect(shown).toEqual(["region:a", null]);
    controller.pointer(null);
    controller.pointer(A);
    advance(openMs);
    expect(shown).toEqual(["region:a", null, "region:a"]);
  });

  it("a press on a badge before its list opened keeps it shut too", () => {
    const { controller, advance, shown } = rig();
    controller.pointer(A);
    advance(openMs / 2);
    controller.dismiss();
    advance(openMs * 4);
    expect(shown).toEqual([]);
  });

  it("a pointer that moves from one badge to another closes the first at once and waits to open the second", () => {
    const { controller, advance, shown } = rig();
    controller.pointer(A);
    advance(openMs);
    controller.pointer(B);
    expect(shown).toEqual(["region:a", null]);
    advance(openMs);
    expect(shown).toEqual(["region:a", null, "region:b"]);
  });

  it("disposes with no timer left running", () => {
    const { controller, pendingTimers } = rig();
    controller.pointer(A);
    controller.dispose();
    expect(pendingTimers()).toBe(0);
  });
});
