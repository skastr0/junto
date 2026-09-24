/**
 * The reviews product gate.
 *
 * Off (ship), two seats connect only as messages: drawing offers one verb, so
 * no family choice appears, and no authoring path writes a new reviews edge.
 * A reviews edge already on the canvas is left as it was. On (all-on), the
 * pair offers messages and reviews.
 *
 * Each half runs in the profile it describes: `bun run test:features:ship`
 * runs the off half, `bun run test` (all-on) runs the on half.
 */

import { describe, expect, it } from "vitest";
import { resolveBuildFeatures } from "../scripts/build-features";
import { applyMirrorLaw, type CanvasDoc, type CanvasEdge, type CanvasNode } from "../src/shared/canvas";
import { REVIEWS_ENABLED } from "../src/shared/features";
import { applyCanvasBatch } from "../src/shared/overseer-authoring";
import type { OverseerCanvasBatchStep } from "../src/shared/overseer-control";
import { verbsForDraw } from "../src/renderer/lib/edge-mutations";

const seat = (id: string, x: number): CanvasNode => ({
  id,
  type: "text",
  text: id,
  x,
  y: 0,
  width: 260,
  height: 96,
  ether: {
    entity: { kind: "agent", name: "local:amp" },
    host: "local",
    terminal: { bindingId: `bind-${id}`, harness: "amp" },
  },
});

const doc = (edges: ReadonlyArray<CanvasEdge> = []): CanvasDoc =>
  applyMirrorLaw({ nodes: [seat("a", 0), seat("b", 400)], edges: [...edges] });

const batch = (current: CanvasDoc, operations: ReadonlyArray<OverseerCanvasBatchStep>) =>
  applyCanvasBatch(new Map([["ops", current]]), "ops", operations, (kind) => `${kind}-minted`);

const messagesEdge: CanvasEdge = { id: "e1", fromNode: "a", toNode: "b", ether: { verb: "messages" } };
const reviewsEdge: CanvasEdge = { id: "e1", fromNode: "a", toNode: "b", ether: { verb: "reviews" } };

describe("reviews product gate", () => {
  it("resolves off in the ship profile and on for the all-on profile", () => {
    expect(resolveBuildFeatures({}).features.reviews).toBe(false);
    expect(resolveBuildFeatures({ JUNTO_FEATURE_PROFILE: "all-on" }).features.reviews).toBe(true);
    expect(resolveBuildFeatures({ JUNTO_REVIEWS: "1" }).features.reviews).toBe(true);
  });

  it.runIf(!REVIEWS_ENABLED)("two seats connect only as messages", () => {
    expect(verbsForDraw("agent", "agent")).toEqual({ verbs: ["messages"], reversed: false });

    const connect = batch(doc(), [
      { operation: "edge.connect", edge: { fromNode: "a", toNode: "b", verb: "reviews" } },
    ]);
    expect(connect).toMatchObject({ ok: false, error: { type: "Forbidden" } });

    const swap = batch(doc([messagesEdge]), [
      { operation: "edge.configure", edgeId: "e1", changes: { verb: "reviews" } },
    ]);
    expect(swap).toMatchObject({ ok: false, error: { type: "Forbidden" } });
  });

  it.runIf(!REVIEWS_ENABLED)("leaves a reviews edge already on the canvas editable", () => {
    const relabel = batch(doc([reviewsEdge]), [
      { operation: "edge.configure", edgeId: "e1", changes: { label: "second pass" } },
    ]);
    expect(relabel.ok).toBe(true);
    if (relabel.ok) {
      expect(relabel.doc.edges).toMatchObject([{ id: "e1", label: "second pass", ether: { verb: "reviews" } }]);
    }
  });

  it.runIf(REVIEWS_ENABLED)("two seats choose between messages and reviews", () => {
    expect(verbsForDraw("agent", "agent")).toEqual({ verbs: ["messages", "reviews"], reversed: false });

    const connect = batch(doc(), [
      { operation: "edge.connect", edge: { fromNode: "a", toNode: "b", verb: "reviews" } },
    ]);
    expect(connect.ok).toBe(true);
  });
});
