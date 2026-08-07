import { describe, expect, it } from "vitest";
import {
  alertId,
  cycleNext,
  emptyAlertQueue,
  observeSignals,
  resolveFocusNodeId,
  type AlertQueue,
  type AlertSignal,
} from "../src/renderer/lib/alert-queue";

const sig = (partial: AlertSignal): AlertSignal => partial;
const attention = (nodeId: string): AlertSignal => sig({
  id: alertId.node(nodeId), kind: "attention", subjectKey: nodeId, nodeId, level: 1,
});
const blocked = (nodeId: string): AlertSignal => sig({
  id: alertId.node(nodeId), kind: "blocked", subjectKey: nodeId, nodeId, level: 2,
});

describe("alert-queue", () => {
  describe("observeSignals — baseline and escalation", () => {
    it("baselines the first frame without an alert", () => {
      const { queue, risen } = observeSignals(emptyAlertQueue(), [attention("n1"), blocked("n2")], 1000);
      expect(risen).toEqual([]);
      expect(queue.baselined).toBe(true);
      expect(queue.items).toEqual([]);
      expect(queue.known).toEqual({ [alertId.node("n1")]: "1", [alertId.node("n2")]: "2" });
    });

    it("rises when an idle node enters attention or blocked", () => {
      const q = observeSignals(emptyAlertQueue(), [], 1).queue;
      const result = observeSignals(q, [attention("n1"), blocked("n2")], 2);
      expect(result.risen.map((item) => [item.id, item.kind, item.level])).toEqual([
        [alertId.node("n1"), "attention", 1],
        [alertId.node("n2"), "blocked", 2],
      ]);
    });

    it("rises again only when attention escalates to blocked", () => {
      let q = observeSignals(emptyAlertQueue(), [attention("n1")], 1).queue;
      const escalation = observeSignals(q, [blocked("n1")], 2);
      expect(escalation.risen).toEqual([
        expect.objectContaining({ id: alertId.node("n1"), kind: "blocked", level: 2, at: 2 }),
      ]);

      q = escalation.queue;
      const deescalation = observeSignals(q, [attention("n1")], 3);
      expect(deescalation.risen).toEqual([]);
      expect(deescalation.queue.items).toEqual([
        expect.objectContaining({ id: alertId.node("n1"), kind: "attention", level: 1, at: 2 }),
      ]);

      const reescalation = observeSignals(deescalation.queue, [blocked("n1")], 4);
      expect(reescalation.risen).toEqual([
        expect.objectContaining({ id: alertId.node("n1"), kind: "blocked", level: 2, at: 4 }),
      ]);
    });

    it("clears a node when it returns to idle", () => {
      let q = observeSignals(emptyAlertQueue(), [], 1).queue;
      q = observeSignals(q, [blocked("n1")], 2).queue;
      const cleared = observeSignals(q, [], 3);
      expect(cleared.risen).toEqual([]);
      expect(cleared.queue.items).toEqual([]);
      expect(cleared.queue.known[alertId.node("n1")]).toBeUndefined();
    });
  });

  describe("priority and cycling", () => {
    it("orders blocked before attention before ready before working", () => {
      let q = observeSignals(emptyAlertQueue(), [], 1).queue;
      const ready = (nodeId: string): AlertSignal => sig({
        id: alertId.node(nodeId), kind: "ready", subjectKey: nodeId, nodeId, level: 2,
      });
      const working = (nodeId: string): AlertSignal => sig({
        id: alertId.node(nodeId), kind: "working", subjectKey: nodeId, nodeId, level: 1,
      });
      q = observeSignals(q, [working("w"), attention("a"), ready("r"), blocked("b")], 2).queue;
      expect(q.items.map((item) => item.kind)).toEqual([
        "blocked",
        "attention",
        "ready",
        "working",
      ]);
    });

    it("cycleNext skips unfocusable items", () => {
      let q = observeSignals(emptyAlertQueue(), [], 1).queue;
      q = observeSignals(q, [
        sig({ id: alertId.node("ghost"), kind: "blocked", subjectKey: "ghost", level: 2 }),
        blocked("real"),
      ], 2).queue;
      expect(cycleNext(q).item?.nodeId).toBe("real");
    });

    const seeded = (): AlertQueue => {
      let q = observeSignals(emptyAlertQueue(), [], 1).queue;
      return observeSignals(q, [blocked("a"), blocked("b"), blocked("c")], 2).queue;
    };

    it("advances and wraps", () => {
      let q = seeded();
      q = cycleNext(q).queue;
      q = cycleNext(q).queue;
      const third = cycleNext(q);
      expect(third.item?.nodeId).toBe("c");
      expect(cycleNext(third.queue).item?.nodeId).toBe("a");
    });

    it("clamps cycleIndex when items shrink past it", () => {
      let q = seeded();
      q = cycleNext(q).queue;
      q = cycleNext(q).queue;
      q = cycleNext(q).queue;
      const shrunk = observeSignals(q, [blocked("a")], 9).queue;
      expect(shrunk.cycleIndex).toBe(0);
    });
  });

  describe("helpers", () => {
    it("builds a stable node alert id", () => {
      expect(alertId.node("n")).toBe("node:n");
    });

    it("resolves focus targets only when present", () => {
      expect(resolveFocusNodeId({ id: "x", kind: "blocked", subjectKey: "x", nodeId: "node-1", at: 1 })).toBe("node-1");
      expect(resolveFocusNodeId({ id: "x", kind: "attention", subjectKey: "x", nodeId: "  ", at: 1 })).toBeUndefined();
    });
  });
});
