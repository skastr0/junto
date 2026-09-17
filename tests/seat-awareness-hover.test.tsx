/**
 * SeatAwarenessHover — rendered presentation.
 *
 * Renders the real component to static markup (the repository's renderer test
 * workflow: no jsdom, no effects) and holds the operator-facing invariants:
 *   - the deterministic control status always renders, and canonical attention
 *     is never downgraded by an AI answer
 *   - fresh / stale / abstained / unavailable are visually distinct states
 *   - the excerpt is inert text: escaped, bounded, no link, no handler
 *   - hovering never marks a seat seen
 *   - design-system primitives and tokens only, no hardcoded palette
 *   - no U+00B7 anywhere in the rendered copy
 */

import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SeatAwarenessHover } from "../src/renderer/components/terminal/SeatAwarenessHover";
import { cardMark, seatFactsForNode } from "../src/renderer/lib/seat-projections";
import {
  agentSeat$,
  resetAgentSeatState,
} from "../src/renderer/lib/agent-seat-state";
import type {
  SeatAwarenessAssessment,
  SeatAwarenessEvidenceLine,
} from "../src/renderer/lib/seat-awareness-contract";
import {
  applySeatAwarenessEvent,
  awarenessForBinding,
  resetSeatAwareness,
  seatAwarenessViewForBinding,
  type SeatAwarenessControl,
} from "../src/renderer/lib/seat-awareness";

const T0 = 1_700_000_000_000;
const MIDDLE_DOT = "\u00B7";
const HOVER_SOURCE = new URL(
  "../src/renderer/components/terminal/SeatAwarenessHover.tsx",
  import.meta.url,
);

const line = (id: string, text: string): SeatAwarenessEvidenceLine => ({ id, text });

const assessment = (
  partial: Partial<SeatAwarenessAssessment> & { readonly bindingId: string },
): SeatAwarenessAssessment => ({
  assessmentId: "assessment-1",
  availability: "current",
  observedAt: T0,
  activity: "testing",
  concerns: [],
  absences: [],
  unansweredConcerns: [],
  evidence: {
    digest: "w1",
    capturedAt: T0,
    lines: [line("l1", "3 tests failed in auth.spec.ts")],
  },
  selectedLineId: "l1",
  unavailableReason: null,
  ...partial,
});

const working: SeatAwarenessControl = {
  state: "working",
  label: "Working",
  tone: "cyan",
};

const render = (
  props: Partial<Parameters<typeof SeatAwarenessHover>[0]> = {},
): string =>
  renderToStaticMarkup(
    <SeatAwarenessHover
      bindingId="b1"
      control={working}
      now={T0 + 8_000}
      {...props}
    />,
  );

beforeEach(() => {
  resetAgentSeatState();
  resetSeatAwareness();
});

afterEach(() => {
  resetAgentSeatState();
  resetSeatAwareness();
});

describe("fresh, stale, abstained, and unavailable states", () => {
  it("renders attribution, label, an age-attributed excerpt, and freshness", () => {
    const html = render({
      assessment: assessment({ bindingId: "b1" }),
    });
    expect(html).toContain('data-seat-awareness="current"');
    expect(html).toContain("AI assessment");
    expect(html).toContain("Likely testing");
    expect(html).toContain("terminal excerpt (observed 8s ago)");
    expect(html).toContain("3 tests failed in auth.spec.ts");
    expect(html).toContain("AI assessment, observed 8s ago");
    expect(html).toContain("CURRENT");
    expect(html).toContain('data-awareness-judgment="current"');
    // The excerpt carries no currency claim, so it has no currency state.
    expect(html).not.toContain("data-awareness-excerpt");
    expect(html).not.toContain(">terminal excerpt<");
  });

  it("attributes the excerpt to its own observation age, whatever the screen did", () => {
    // The ordinary case: the excerpt is a quotation with an age. A live
    // revision that moved on, or one that matches exactly, changes nothing
    // about it — the judgment is what claims currency.
    const html = render({
      control: { state: "working", label: "Working", tone: "cyan" },
      assessment: assessment({ bindingId: "b1" }),
    });
    expect(html).toContain('data-seat-awareness="current"');
    expect(html).toContain('data-awareness-judgment="current"');
    expect(html).toContain("Likely testing");
    expect(html).toContain("AI assessment, observed 8s ago");
    expect(html).toContain("CURRENT");
    expect(html).toContain("terminal excerpt (observed 8s ago)");
    expect(html).toContain("3 tests failed in auth.spec.ts");
    expect(html).not.toContain("last observed");
  });

  it("marks the judgment stale when the seat has left the turn", () => {
    const html = render({
      control: { state: "idle", label: "Idle", tone: "steel" },
      assessment: assessment({ bindingId: "b1" }),
    });
    expect(html).toContain('data-seat-awareness="stale"');
    expect(html).toContain('data-awareness-judgment="stale"');
    expect(html).toContain("LAST OBSERVED");
    expect(html).toContain("AI assessment, last observed 8s ago");
    expect(html).not.toContain("AI assessment, observed 8s ago");
    // The excerpt is unaffected: it is still its own observation, with its age.
    expect(html).toContain("terminal excerpt (observed 8s ago)");
    expect(html).not.toContain("last observed at");
  });

  it("says checked and clear for a decisive negative, not no judgment", () => {
    const html = render({
      assessment: assessment({
        bindingId: "b1",
        activity: "indeterminate",
        concerns: [],
        selectedLineId: null,
        absences: [{ concern: "execution_error", probability: 0.04 }],
      }),
    });
    expect(html).toContain('data-awareness-cleared="checked_and_clear"');
    expect(html).toContain('data-awareness-judgment="current"');
    expect(html).toContain("checked and clear");
    expect(html).toContain("AI assessment, observed 8s ago");
    expect(html).toContain("CURRENT");
    // The wrong claim is gone: this is a judgment, not an abstention.
    expect(html).not.toContain("NO JUDGMENT");
    expect(html).not.toContain("recent terminal output available");
    // And it is not the deterministic fallback either.
    expect(html).not.toContain("NOT ASSESSED");
  });

  it("keeps the cleared fact visible under a determinate activity", () => {
    const html = render({
      assessment: assessment({
        bindingId: "b1",
        activity: "testing",
        concerns: [],
        selectedLineId: null,
        absences: [{ concern: "repetition", probability: 0.08 }],
      }),
    });
    expect(html).toContain('data-awareness-cleared="checked_and_clear"');
    expect(html).toContain("Likely testing");
    expect(html).toContain("checked and clear");
    expect(html).toContain("CURRENT");
    expect(html).not.toContain("NO JUDGMENT");
  });

  it("shows the weaker clear claim when the producer never reported the unanswered list", () => {
    // Absent and empty are different claims on the rendered surface too: a
    // producer that stayed silent about which questions went unanswered can only
    // support "no concern raised", never "checked and clear".
    const { unansweredConcerns: _absent, ...silent } = assessment({
      bindingId: "b1",
      activity: "indeterminate",
      concerns: [],
      selectedLineId: null,
      absences: [{ concern: "approval_requested", probability: 0.06 }],
    });
    const html = render({ assessment: silent as SeatAwarenessAssessment });
    expect(html).toContain('data-awareness-cleared="no_concern_raised"');
    expect(html).toContain('data-awareness-judgment="current"');
    expect(html).toContain("no concern raised");
    expect(html).toContain("CURRENT");
    expect(html).not.toContain("checked and clear");
    expect(html).not.toContain("NO JUDGMENT");
  });

  it("keeps a stale decisive negative honest: the claim stays, the currency goes", () => {
    const html = render({
      control: { state: "idle", label: "Idle", tone: "steel" },
      assessment: assessment({
        bindingId: "b1",
        activity: null,
        concerns: [],
        selectedLineId: null,
        absences: [{ concern: "repetition", probability: 0.1 }],
      }),
    });
    expect(html).toContain('data-awareness-cleared="checked_and_clear"');
    expect(html).toContain('data-awareness-judgment="stale"');
    expect(html).toContain("checked and clear");
    expect(html).toContain("AI assessment, last observed 8s ago");
    expect(html).toContain("LAST OBSERVED");
    // The weaker claim would assert that some question went unanswered, which is
    // false for a complete assessment that has merely aged.
    expect(html).not.toContain("no concern raised");
  });

  it("renders an abstention as the deterministic status plus a neutral line", () => {
    const html = render({
      assessment: assessment({
        bindingId: "b1",
        availability: "abstained",
        activity: null,
        selectedLineId: null,
      }),
    });
    expect(html).toContain('data-seat-awareness="abstained"');
    expect(html).toContain("NO JUDGMENT");
    expect(html).toContain("Working");
    expect(html).toContain("recent terminal output available");
    expect(html).toContain("text-dim");
    expect(html).not.toContain("Likely");
    expect(html).not.toContain("terminal excerpt");
  });

  it("renders a missing key, provider failure, or spent budget honestly", () => {
    const missingKey = render({
      assessment: assessment({
        bindingId: "b1",
        availability: "unavailable",
        activity: null,
        selectedLineId: null,
        unavailableReason: "missing_key",
      }),
    });
    expect(missingKey).toContain('data-seat-awareness="unavailable"');
    expect(missingKey).toContain("UNAVAILABLE");
    expect(missingKey).toContain("AI assessment unavailable: no API key configured");
    expect(missingKey).not.toContain("Likely");

    const budget = render({
      assessment: assessment({
        bindingId: "b1",
        availability: "unavailable",
        activity: null,
        selectedLineId: null,
        unavailableReason: "budget_exhausted",
      }),
    });
    expect(budget).toContain("assessment budget spent");
  });

  it("names the gate-off reason, and keeps it distinct from not assessed and from a missing key", () => {
    // The day-one impression for every install with the sidecar disabled. The
    // gate publishes unavailable/not_configured rather than nothing, so the card
    // says the sidecar is off instead of leaving the operator to read NOT
    // ASSESSED as "pending". Three genuinely different facts, three renders.
    const disabled = render({
      assessment: assessment({
        bindingId: "b1",
        availability: "unavailable",
        activity: null,
        selectedLineId: null,
        unavailableReason: "not_configured",
      }),
    });
    expect(disabled).toContain('data-seat-awareness="unavailable"');
    expect(disabled).toContain("UNAVAILABLE");
    expect(disabled).toContain("AI assessment unavailable: the sidecar is not configured");
    expect(disabled).toContain("Working");
    expect(disabled).not.toContain("NOT ASSESSED");
    expect(disabled).not.toContain("NO JUDGMENT");
    expect(disabled).not.toContain("Likely");

    const enabledNoKey = render({
      assessment: assessment({
        bindingId: "b1",
        availability: "unavailable",
        activity: null,
        selectedLineId: null,
        unavailableReason: "missing_key",
      }),
    });
    expect(enabledNoKey).toContain("AI assessment unavailable: no API key configured");

    // No observation yet for this binding: the renderer's own derivation, and a
    // different claim from the sidecar being off.
    const notYet = render();
    expect(notYet).toContain('data-seat-awareness="not_assessed"');
    expect(notYet).toContain("NOT ASSESSED");
    expect(notYet).toContain("recent terminal output available");

    const copy = [disabled, enabledNoKey, notYet];
    expect(new Set(copy).size).toBe(3);
    expect(disabled).not.toContain("recent terminal output available");
  });

  it("still shows the deterministic status with no assessment at all", () => {
    const html = render();
    expect(html).toContain('data-seat-awareness="not_assessed"');
    expect(html).toContain("NOT ASSESSED");
    expect(html).toContain("Working");
    expect(html).toContain("recent terminal output available");
    expect(html).not.toContain("AI assessment");
  });
});

describe("authority boundary at presentation", () => {
  it("renders the existing deterministic status, not a parallel one", () => {
    // The control plane is whatever `cardMark` (lib/activity.ts, the card
    // painter) already derives — the hover composes with it, it does not
    // re-derive status.
    const activity = cardMark(
      seatFactsForNode({
        nodeId: "n1",
        seatEvent: { state: "attention", reason: "permission" },
        session: { status: "running", processName: "claude", title: "claude" },
        managedSeat: true,
      }),
    );
    expect(activity.label).toBe("needs operator input");
    const html = render({
      control: {
        state: "attention",
        label: activity.label,
        tone: activity.tone,
        pulse: activity.mode === "pulse",
      },
      assessment: assessment({ bindingId: "b1", activity: "testing" }),
    });
    expect(html).toContain("needs operator input");
    expect(html).toContain("var(--color-amber)");
    expect(html).toContain("Likely testing");

    // Ready/complete (idle + unseen) keeps its green pulse dot.
    const doneActivity = cardMark(
      seatFactsForNode({ nodeId: "n1", seatEvent: { state: "idle", reason: "idle" }, needsLook: true }),
    );
    const doneHtml = render({
      control: {
        state: "done",
        label: doneActivity.label,
        tone: doneActivity.tone,
        pulse: doneActivity.mode === "pulse",
      },
      now: T0,
    });
    expect(doneActivity.label).toBe("Ready — waiting for review");
    expect(doneHtml).toContain("junto-status-dot-pulse");
    expect(doneHtml).toContain("var(--color-green)");
  });

  it("renders from the store the parent will wire", () => {
    applySeatAwarenessEvent({
      kind: "assessment",
      assessment: assessment({ bindingId: "b1" }),
      windowDigest: "w1",
      at: T0,
    });
    const view = seatAwarenessViewForBinding({
      bindingId: "b1",
      control: working,
      now: T0 + 8_000,
    });
    expect(view.availability).toBe("current");
    const html = renderToStaticMarkup(
      <SeatAwarenessHover
        bindingId="b1"
        control={view.control}
        assessment={awarenessForBinding("b1")}
        now={T0 + 8_000}
      />,
    );
    expect(html).toContain("Likely testing");
    expect(html).toContain("3 tests failed in auth.spec.ts");
    // An unknown binding still renders the deterministic surface.
    expect(
      seatAwarenessViewForBinding({ bindingId: "unbound", control: working, now: T0 }).availability,
    ).toBe("not_assessed");
  });

  it("never downgrades a canonical attention seat", () => {
    const html = render({
      control: {
        state: "attention",
        label: "needs operator input",
        tone: "amber",
        detail: "stalled - needs operator look",
      },
      assessment: assessment({ bindingId: "b1", activity: "testing" }),
    });
    expect(html).toContain('data-awareness-control-state="attention"');
    expect(html).toContain('data-awareness-attention="true"');
    expect(html).toContain("needs operator input");
    expect(html).toContain("stalled - needs operator look");
    // The AI answer is a separate, attributed plane — never the control state.
    expect(html).toContain('data-awareness-ai-label="Likely testing"');
    expect(html).not.toContain('data-awareness-control-state="testing"');
    expect(html).toContain('data-seat-awareness="current"');
    expect(html).toContain('role="tooltip"');
  });

  it("does not read or write seat state, so hovering cannot mark a seat seen", () => {
    agentSeat$.needsLookByBindingId["b1"].set(true);
    agentSeat$.byBindingId["b1"].set({
      bindingId: "b1",
      epoch: "e1",
      state: "idle",
      reason: "idle",
      confidence: "high",
      at: T0,
    });
    render({
      control: { state: "done", label: "Ready - waiting for review", tone: "green", pulse: true },
      assessment: assessment({ bindingId: "b1" }),
    });
    expect(agentSeat$.needsLookByBindingId["b1"].peek()).toBe(true);
    expect(agentSeat$.byBindingId["b1"].peek()?.state).toBe("idle");
    expect(agentSeat$.rev.peek()).toBe(0);

    // Structural: the leaf cannot mark anything seen, and touches no seat store.
    // Comments are stripped first — prose may name the invariant, code may not.
    const source = readFileSync(HOVER_SOURCE, "utf8")
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/^\s*\/\/.*$/gmu, "");
    expect(source).not.toContain("markAgentSeatSeen");
    expect(source).not.toContain("agentSeat$");
    expect(source).not.toContain("needsLook");
    expect(source).not.toContain("useEffect");
    expect(source).not.toContain("dangerouslySetInnerHTML");
    expect(source).not.toContain("use$(");
  });
});

describe("excerpt rendering", () => {
  it("renders terminal text as inert, escaped text — never a link or an instruction", () => {
    const html = render({
      assessment: assessment({
        bindingId: "b1",
        evidence: {
          digest: "w1",
          capturedAt: T0,
          lines: [
            line("l1", "<script>alert(1)</script> see https://evil.example/x"),
          ],
        },
      }),
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("javascript:");
  });

  it("renders no middle dot even when the terminal supplied one", () => {
    const html = render({
      assessment: assessment({
        bindingId: "b1",
        evidence: {
          digest: "w1",
          capturedAt: T0,
          lines: [line("l1", `npm ${MIDDLE_DOT} run build`)],
        },
      }),
    });
    expect(html).not.toContain(MIDDLE_DOT);
    expect(html).toContain("npm run build");
  });

  it("shows no excerpt when the selected line is not in this observation's window", () => {
    const html = render({
      assessment: assessment({ bindingId: "b1", selectedLineId: "missing" }),
    });
    expect(html).not.toContain("terminal excerpt");
    expect(html).toContain("Likely testing");
    expect(html).toContain("AI assessment, observed 8s ago");
  });
});

describe("design system", () => {
  it("composes the shared primitives and tokens with no hardcoded palette", () => {
    const html = render({
      assessment: assessment({ bindingId: "b1", concerns: ["approval_requested", "repetition"] }),
    });
    for (const token of [
      "bg-raise",
      "border-stroke",
      "text-ink",
      "text-faint",
      "text-steel",
      "font-mono",
      "tabular-nums",
    ]) {
      expect(html, token).toContain(token);
    }
    // Primitive shapes: the header chrome, the availability chip, the dot.
    expect(html).toContain("<header");
    expect(html).toContain("uppercase");
    expect(html).toContain("border-radius:999px");
    // No raw palette values — colors come from the token layer.
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).not.toMatch(/\brgba?\(/);
    // A second concern is annotated, not folded into the headline.
    expect(html).toContain("AI suggests checking approval");
    expect(html).toContain("AI suggests checking a repeat");
  });
});
