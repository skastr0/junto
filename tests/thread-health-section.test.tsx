/**
 * Seat sidebar health section: rendered to static markup with a reading seeded
 * through the real awareness event path (decode-free apply), the way the
 * sidecar delivers it.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { CanvasNode } from "../src/shared/canvas";
import { ThreadHealthSection } from "../src/renderer/components/terminal/ThreadHealthSection";
import { applySeatAwarenessEvent, resetSeatAwareness } from "../src/renderer/lib/seat-awareness";
import type { SeatAwarenessAssessment } from "../src/renderer/lib/seat-awareness-contract";

const node: CanvasNode = {
  id: "seat-1",
  type: "text",
  text: "yakjev-1",
  x: 0,
  y: 0,
  width: 240,
  height: 120,
  ether: {
    entity: { kind: "agent", name: "local:yakjev-1" },
    terminal: { bindingId: "bind-1", harness: "claude", launch: { kind: "harness", argv: ["claude"] } },
  },
};

const assessment = (health: SeatAwarenessAssessment["health"]): SeatAwarenessAssessment => ({
  bindingId: "bind-1",
  assessmentId: "as-1",
  availability: "current",
  observedAt: Date.now(),
  activity: null,
  concerns: [],
  absences: [],
  unansweredConcerns: [],
  evidence: { digest: "d1", capturedAt: Date.now(), lines: [] },
  selectedLineId: null,
  unavailableReason: null,
  ...(health !== undefined ? { health } : {}),
});

afterEach(() => resetSeatAwareness());

describe("ThreadHealthSection", () => {
  it("renders nothing when the seat has no reading", () => {
    applySeatAwarenessEvent({ kind: "assessment", assessment: assessment(undefined), windowDigest: "d1", at: 1 });
    expect(renderToStaticMarkup(<ThreadHealthSection node={node} />)).toBe("");
  });

  it("shows the AI reading of a thread waiting on the operator, with its provenance", () => {
    const at = Date.now();
    applySeatAwarenessEvent({
      kind: "assessment",
      windowDigest: "d1",
      at: 2,
      assessment: {
        ...assessment({
          bindingId: "bind-1",
          value: "waiting_on_operator",
          confidence: 0.96,
          observedAt: at,
          provenance: { source: "jev", assessmentId: "as-1", questionId: "health.waiting_on_operator", packVersion: "awareness-pack/2" },
          signals: [{ value: "waiting_on_operator", probability: 0.96, questionId: "health.waiting_on_operator" }],
        }),
        observedAt: at,
      },
    });
    const html = renderToStaticMarkup(<ThreadHealthSection node={node} />);
    expect(html).toContain("AI reads wants your input");
    expect(html).toContain("96%");
    expect(html).toContain("Not the agent&#x27;s own claim.");
    expect(html).toContain('data-health-tone="waiting"');
    expect(html).not.toContain("·");
  });
});
