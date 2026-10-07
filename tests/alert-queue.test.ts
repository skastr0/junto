/**
 * Rising edges for the attention sounds: what rises, what does not.
 */
import { describe, expect, it } from "vitest";
import { alertId, emptyAlertQueue, observeSignals, type AlertKind, type AlertSignal } from "../src/renderer/lib/alert-queue";
import { ALERT_URGENCY } from "../src/renderer/lib/alert-attention";

const signal = (nodeId: string, kind: AlertKind): AlertSignal => ({
  id: alertId.node(nodeId),
  kind,
  subjectKey: nodeId,
  urgency: ALERT_URGENCY[kind],
});

const baselined = (signals: ReadonlyArray<AlertSignal> = []) => observeSignals(emptyAlertQueue(), signals).queue;

describe("alert rises", () => {
  it("the first observe is the baseline: nothing has risen", () => {
    const first = observeSignals(emptyAlertQueue(), [signal("a", "blocked")]);
    expect(first.risen).toEqual([]);
    expect(first.queue.baselined).toBe(true);
    // What was there at the baseline is not news on the next look either.
    expect(observeSignals(first.queue, [signal("a", "blocked")]).risen).toEqual([]);
  });

  it("a subject that appears after the baseline rises", () => {
    const next = observeSignals(baselined(), [signal("a", "attention"), signal("b", "working")]);
    expect(next.risen.map((entry) => [entry.subjectKey, entry.kind])).toEqual([
      ["a", "attention"],
      ["b", "working"],
    ]);
  });

  it("a subject rises again when it becomes more urgent, by the shared urgency table", () => {
    let queue = baselined([signal("a", "working")]);
    const toReady = observeSignals(queue, [signal("a", "ready")]);
    expect(toReady.risen.map((entry) => entry.kind)).toEqual(["ready"]);
    queue = toReady.queue;
    const toBlocked = observeSignals(queue, [signal("a", "blocked")]);
    expect(toBlocked.risen.map((entry) => entry.kind)).toEqual(["blocked"]);
  });

  it("a subject that calms down, or is re-sent unchanged, does not rise", () => {
    const queue = baselined([signal("a", "blocked")]);
    expect(observeSignals(queue, [signal("a", "blocked")]).risen).toEqual([]);
    const calmer = observeSignals(queue, [signal("a", "working")]);
    expect(calmer.risen).toEqual([]);
    // From the calmer state, getting urgent again is a rise.
    expect(observeSignals(calmer.queue, [signal("a", "attention")]).risen).toHaveLength(1);
  });

  it("a subject that left and comes back rises, unless it was held", () => {
    const queue = baselined([signal("a", "attention")]);
    const gone = observeSignals(queue, []);
    expect(observeSignals(gone.queue, [signal("a", "attention")]).risen).toHaveLength(1);

    // Held: its state was unknown for a moment; back where it was is not news.
    const held = observeSignals(queue, [], new Set([alertId.node("a")]));
    expect(observeSignals(held.queue, [signal("a", "attention")]).risen).toEqual([]);
    // Back and more urgent than before the gap: that is news.
    expect(observeSignals(held.queue, [signal("a", "blocked")]).risen).toHaveLength(1);
  });
});
