import { describe, expect, it } from "vitest";
import {
  alertId,
  cycleNext,
  emptyAlertQueue,
  observeSignals,
  regionIdFromOrphanKey,
  resolveFocusNodeId,
  type AlertQueue,
  type AlertSignal,
} from "../src/renderer/lib/alert-queue";

const sig = (partial: AlertSignal): AlertSignal => partial;

describe("alert-queue", () => {
  describe("observeSignals — baseline", () => {
    it("first observe baselines without risen items", () => {
      const signals: AlertSignal[] = [
        sig({ id: alertId.blocked("n1"), kind: "blocked", subjectKey: "n1", nodeId: "n1" }),
        sig({ id: alertId.permission("host:bot"), kind: "permission", subjectKey: "host:bot", nodeId: "a1" }),
      ];
      const { queue, risen } = observeSignals(emptyAlertQueue(), signals, 1000);
      expect(risen).toEqual([]);
      expect(queue.baselined).toBe(true);
      expect(queue.items).toEqual([]);
      expect(queue.known[alertId.blocked("n1")]).toBe("1");
      expect(queue.known[alertId.permission("host:bot")]).toBe("1");
    });

    it("no rise when signals stay steady after baseline", () => {
      const signals: AlertSignal[] = [
        sig({ id: alertId.blocked("n1"), kind: "blocked", subjectKey: "n1", nodeId: "n1" }),
      ];
      let q = emptyAlertQueue();
      q = observeSignals(q, signals, 1).queue;
      const second = observeSignals(q, signals, 2);
      expect(second.risen).toEqual([]);
      // Steady active signals re-enter quietly so Space can still land on them.
      expect(second.queue.items).toHaveLength(1);
      expect(second.queue.items[0]?.id).toBe(alertId.blocked("n1"));
    });
  });

  describe("observeSignals — rising edge", () => {
    it("emits rise when a new subject appears after baseline", () => {
      let q = emptyAlertQueue();
      q = observeSignals(q, [], 1).queue;
      const { queue, risen } = observeSignals(
        q,
        [sig({ id: alertId.permission("h:a"), kind: "permission", subjectKey: "h:a", nodeId: "n9", label: "agent" })],
        50,
      );
      expect(risen).toHaveLength(1);
      expect(risen[0]).toMatchObject({
        id: alertId.permission("h:a"),
        kind: "permission",
        subjectKey: "h:a",
        nodeId: "n9",
        at: 50,
      });
      expect(queue.items).toHaveLength(1);
      expect(queue.items[0]?.id).toBe(alertId.permission("h:a"));
    });

    it("detects blocked / herdr-done / orphan presence rises", () => {
      let q = emptyAlertQueue();
      q = observeSignals(q, [], 1).queue;
      const { risen } = observeSignals(
        q,
        [
          sig({ id: alertId.blocked("b1"), kind: "blocked", subjectKey: "b1", nodeId: "b1" }),
          sig({ id: alertId.herdrDone("h1"), kind: "herdr-done", subjectKey: "h1", nodeId: "h1" }),
          sig({ id: alertId.orphan("c::r1"), kind: "orphan", subjectKey: "c::r1", nodeId: "r1" }),
        ],
        2,
      );
      expect(risen.map((r) => r.kind).sort()).toEqual(["blocked", "herdr-done", "orphan"]);
    });

    it("booth-review rises on first pending and again when level increases", () => {
      let q = emptyAlertQueue();
      q = observeSignals(q, [], 1).queue;

      const first = observeSignals(
        q,
        [sig({ id: alertId.boothReview("prism"), kind: "booth-review", subjectKey: "prism", level: 2, nodeId: "p1" })],
        10,
      );
      expect(first.risen).toHaveLength(1);
      expect(first.risen[0]?.level).toBe(2);
      q = first.queue;

      const steady = observeSignals(
        q,
        [sig({ id: alertId.boothReview("prism"), kind: "booth-review", subjectKey: "prism", level: 2, nodeId: "p1" })],
        20,
      );
      expect(steady.risen).toEqual([]);
      q = steady.queue;

      const up = observeSignals(
        q,
        [sig({ id: alertId.boothReview("prism"), kind: "booth-review", subjectKey: "prism", level: 5, nodeId: "p1" })],
        30,
      );
      expect(up.risen).toHaveLength(1);
      expect(up.risen[0]?.level).toBe(5);
      expect(up.queue.items).toHaveLength(1);
      expect(up.queue.items[0]?.level).toBe(5);
    });

    it("does not re-rise on level decrease", () => {
      let q = emptyAlertQueue();
      q = observeSignals(q, [], 1).queue;
      q = observeSignals(
        q,
        [sig({ id: alertId.boothReview("x"), kind: "booth-review", subjectKey: "x", level: 4 })],
        2,
      ).queue;
      const down = observeSignals(
        q,
        [sig({ id: alertId.boothReview("x"), kind: "booth-review", subjectKey: "x", level: 1 })],
        3,
      );
      expect(down.risen).toEqual([]);
      expect(down.queue.items[0]?.level).toBe(1);
    });

    it("removes items when the signal disappears", () => {
      let q = emptyAlertQueue();
      q = observeSignals(q, [], 1).queue;
      q = observeSignals(
        q,
        [
          sig({ id: alertId.blocked("a"), kind: "blocked", subjectKey: "a", nodeId: "a" }),
          sig({ id: alertId.blocked("b"), kind: "blocked", subjectKey: "b", nodeId: "b" }),
        ],
        2,
      ).queue;
      expect(q.items).toHaveLength(2);

      const cleared = observeSignals(
        q,
        [sig({ id: alertId.blocked("b"), kind: "blocked", subjectKey: "b", nodeId: "b" })],
        3,
      );
      expect(cleared.risen).toEqual([]);
      expect(cleared.queue.items.map((i) => i.subjectKey)).toEqual(["b"]);
      expect(cleared.queue.known[alertId.blocked("a")]).toBeUndefined();
    });
  });

  describe("priority order", () => {
    it("orders permission before blocked before herdr before booth before orphan", () => {
      let q = emptyAlertQueue();
      q = observeSignals(q, [], 1).queue;
      const { queue } = observeSignals(
        q,
        [
          sig({ id: alertId.orphan("c::r"), kind: "orphan", subjectKey: "c::r", nodeId: "r" }),
          sig({ id: alertId.boothReview("p"), kind: "booth-review", subjectKey: "p", level: 1, nodeId: "p" }),
          sig({ id: alertId.herdrDone("h"), kind: "herdr-done", subjectKey: "h", nodeId: "h" }),
          sig({ id: alertId.blocked("b"), kind: "blocked", subjectKey: "b", nodeId: "b" }),
          sig({ id: alertId.permission("a"), kind: "permission", subjectKey: "a", nodeId: "a" }),
        ],
        2,
      );
      expect(queue.items.map((i) => i.kind)).toEqual([
        "permission",
        "blocked",
        "herdr-done",
        "booth-review",
        "orphan",
      ]);
    });

    it("cycleNext skips unfocusable items", () => {
      let q = emptyAlertQueue();
      q = observeSignals(q, [], 1).queue;
      q = observeSignals(
        q,
        [
          sig({ id: alertId.blocked("ghost"), kind: "blocked", subjectKey: "ghost" }), // no nodeId
          sig({ id: alertId.blocked("real"), kind: "blocked", subjectKey: "real", nodeId: "real" }),
        ],
        2,
      ).queue;
      const step = cycleNext(q);
      expect(step.item?.nodeId).toBe("real");
    });
  });

  describe("cycleNext", () => {
    const seeded = (): AlertQueue => {
      let q = emptyAlertQueue();
      q = observeSignals(q, [], 1).queue;
      return observeSignals(
        q,
        [
          sig({ id: alertId.blocked("a"), kind: "blocked", subjectKey: "a", nodeId: "na" }),
          sig({ id: alertId.blocked("b"), kind: "blocked", subjectKey: "b", nodeId: "nb" }),
          sig({ id: alertId.blocked("c"), kind: "blocked", subjectKey: "c", nodeId: "nc" }),
        ],
        2,
      ).queue;
    };

    it("starts at first item from cycleIndex -1", () => {
      const q = seeded();
      expect(q.cycleIndex).toBe(-1);
      const step = cycleNext(q);
      expect(step.item?.nodeId).toBe("na");
      expect(step.queue.cycleIndex).toBe(0);
    });

    it("advances and wraps", () => {
      let q = seeded();
      q = cycleNext(q).queue; // 0
      q = cycleNext(q).queue; // 1
      const third = cycleNext(q);
      expect(third.item?.nodeId).toBe("nc");
      expect(third.queue.cycleIndex).toBe(2);
      const wrap = cycleNext(third.queue);
      expect(wrap.item?.nodeId).toBe("na");
      expect(wrap.queue.cycleIndex).toBe(0);
    });

    it("no-ops on empty queue", () => {
      const empty = emptyAlertQueue();
      const step = cycleNext(empty);
      expect(step.item).toBeUndefined();
      expect(step.queue).toEqual(empty);
    });

    it("clamps cycleIndex when items shrink past it", () => {
      let q = seeded();
      q = cycleNext(q).queue;
      q = cycleNext(q).queue;
      q = cycleNext(q).queue; // index 2
      expect(q.cycleIndex).toBe(2);
      // Drop to one item.
      const shrunk = observeSignals(
        q,
        [sig({ id: alertId.blocked("a"), kind: "blocked", subjectKey: "a", nodeId: "na" })],
        9,
      ).queue;
      expect(shrunk.items).toHaveLength(1);
      expect(shrunk.cycleIndex).toBe(0);
    });
  });

  describe("resolveFocusNodeId", () => {
    it("returns nodeId when present", () => {
      expect(
        resolveFocusNodeId({
          id: "x",
          kind: "blocked",
          subjectKey: "x",
          nodeId: "node-1",
          at: 1,
        }),
      ).toBe("node-1");
    });

    it("returns undefined when missing, blank, or item absent", () => {
      expect(resolveFocusNodeId(undefined)).toBeUndefined();
      expect(
        resolveFocusNodeId({
          id: "x",
          kind: "orphan",
          subjectKey: "c::gone",
          at: 1,
        }),
      ).toBeUndefined();
      expect(
        resolveFocusNodeId({
          id: "x",
          kind: "orphan",
          subjectKey: "c::gone",
          nodeId: "  ",
          at: 1,
        }),
      ).toBeUndefined();
    });
  });

  describe("helpers", () => {
    it("builds stable alert ids", () => {
      expect(alertId.blocked("n")).toBe("blocked:n");
      expect(alertId.permission("h:p")).toBe("permission:h:p");
      expect(alertId.herdrDone("n")).toBe("herdr-done:n");
      expect(alertId.boothReview("prj")).toBe("booth-review:prj");
      expect(alertId.orphan("c::r")).toBe("orphan:c::r");
    });

    it("parses region id from orphan key", () => {
      expect(regionIdFromOrphanKey("canvas-a::region-9")).toBe("region-9");
      expect(regionIdFromOrphanKey("no-sep")).toBeUndefined();
      expect(regionIdFromOrphanKey("only::")).toBeUndefined();
    });
  });
});
