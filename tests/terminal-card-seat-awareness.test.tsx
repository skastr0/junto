/**
 * TerminalCard + seat awareness — the mount.
 *
 * The sidecar's whole product is a card surface, so this renders the real card
 * to static markup (the repository's renderer workflow: no jsdom, no effects)
 * with an assessment seeded into the store, and holds the wiring invariants:
 *
 *   - the card subscribes the awareness store where the agent seat state
 *     subscription lives, and the hover is mounted on the card;
 *   - the hover receives the canonical deterministic status unchanged;
 *   - the card still renders its deterministic chrome with no assessment;
 *   - no U+00B7 anywhere in the rendered copy.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSeatStateEvent } from "../src/shared/agent-seat-state";
import type { CanvasNode } from "../src/shared/canvas";
import { TerminalCard } from "../src/renderer/components/terminal/TerminalCard";
import {
  applySeatAwarenessEvent,
  resetSeatAwareness,
} from "../src/renderer/lib/seat-awareness";
import type { SeatAwarenessAssessment } from "../src/renderer/lib/seat-awareness-contract";
import {
  applyAgentSeatStateEvent,
  resetAgentSeatState,
} from "../src/renderer/lib/agent-seat-state";

const T0 = 1_700_000_000_000;
const MIDDLE_DOT = "\u00B7";

const terminalNode = (id: string, bindingId: string): CanvasNode => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 0,
  width: 220,
  height: 90,
  ether: {
    entity: { kind: "terminal" },
    terminal: { bindingId, label: id },
  },
});

const seatEvent = (state: AgentSeatStateEvent["state"]): AgentSeatStateEvent => ({
  bindingId: "b1",
  epoch: "e1",
  state,
  reason: state,
  confidence: "high",
  at: T0,
});

const assessment = (
  partial: Partial<SeatAwarenessAssessment> & { readonly bindingId: string },
): SeatAwarenessAssessment => ({
  assessmentId: "assessment-1",
  availability: "current",
  observedAt: Date.now(),
  activity: "testing",
  concerns: [],
  absences: [],
  unansweredConcerns: [],
  evidence: {
    digest: "w1",
    capturedAt: Date.now(),
    lines: [{ id: "l1", text: "3 tests failed in auth.spec.ts" }],
  },
  selectedLineId: "l1",
  unavailableReason: null,
  ...partial,
});

beforeEach(() => {
  resetAgentSeatState();
  resetSeatAwareness();
});

afterEach(() => {
  resetAgentSeatState();
  resetSeatAwareness();
});

describe("TerminalCard seat awareness", () => {
  it("mounts the hover with the assessment and echoes the deterministic status", () => {
    applyAgentSeatStateEvent(seatEvent("working"));
    applySeatAwarenessEvent({
      kind: "assessment",
      assessment: assessment({ bindingId: "b1" }),
      windowDigest: "w1",
      at: Date.now(),
    });
    const html = renderToStaticMarkup(
      <TerminalCard node={terminalNode("n1", "b1")} />,
    );
    // The canonical deterministic status is on the card and echoed unchanged.
    expect(html).toContain('data-seat-state="working"');
    expect(html).toContain('data-awareness-control-state="working"');
    // The store reached the card and the hover is mounted for this binding.
    expect(html).toContain('data-awareness-binding="b1"');
    expect(html).toContain('data-seat-awareness="current"');
    expect(html).toContain("Likely testing");
    expect(html).toContain("terminal excerpt (observed");
    expect(html).toContain("3 tests failed in auth.spec.ts");
    expect(html).not.toContain(MIDDLE_DOT);
  });

  it("renders the deterministic card unchanged when no assessment exists", () => {
    applyAgentSeatStateEvent(seatEvent("idle"));
    const html = renderToStaticMarkup(
      <TerminalCard node={terminalNode("n1", "b1")} />,
    );
    expect(html).toContain('data-seat-state="idle"');
    expect(html).toContain('data-awareness-control-state="idle"');
    // The hover is mounted but claims nothing it cannot support.
    expect(html).toContain('data-seat-awareness="not_assessed"');
    expect(html).not.toContain("data-awareness-ai-label");
    expect(html).not.toContain("Likely");
    expect(html).not.toContain("AI assessment,");
    expect(html).not.toContain(MIDDLE_DOT);
  });

  it("shows the gate-off notice on the card when the sidecar is disabled", () => {
    applyAgentSeatStateEvent(seatEvent("working"));
    applySeatAwarenessEvent({
      kind: "assessment",
      assessment: assessment({
        bindingId: "b1",
        availability: "unavailable",
        activity: null,
        selectedLineId: null,
        evidence: { digest: "unobserved", capturedAt: Date.now(), lines: [] },
        unavailableReason: "not_configured",
      }),
      windowDigest: "unobserved",
      at: Date.now(),
    });
    const html = renderToStaticMarkup(
      <TerminalCard node={terminalNode("n1", "b1")} />,
    );
    expect(html).toContain('data-seat-awareness="unavailable"');
    expect(html).toContain("AI assessment unavailable: the sidecar is not configured");
    expect(html).not.toContain("NOT ASSESSED");
    expect(html).not.toContain(MIDDLE_DOT);
  });
});
