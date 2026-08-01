import { describe, expect, it } from "vitest";
import {
  initialSessionLoadPhase,
  isSessionLoadActive,
  sessionLoadPresentation,
} from "../src/renderer/lib/session-load";

describe("sessionLoadPresentation", () => {
  it("maps finding / starting / attaching / stuck to distinct tones", () => {
    expect(sessionLoadPresentation({ phase: "finding" }).tone).toBe("cyan");
    expect(sessionLoadPresentation({ phase: "starting" }).tone).toBe("amber");
    expect(sessionLoadPresentation({ phase: "attaching" }).tone).toBe("cyan");
    expect(sessionLoadPresentation({ phase: "stuck" }).tone).toBe("crimson");
  });

  it("resumes with truncated session id and violet tone", () => {
    const p = sessionLoadPresentation({
      phase: "resuming",
      sessionId: "01KYYRTMWV8K31NMBMNJ91RM43",
    });
    expect(p.tone).toBe("violet");
    expect(p.label).toBe("resuming 01KYYRTM…");
  });

  it("resuming without id still labels resume", () => {
    expect(sessionLoadPresentation({ phase: "resuming" }).label).toBe(
      "resuming session",
    );
  });
});

describe("initialSessionLoadPhase", () => {
  it("non-agent shells go straight to attaching", () => {
    expect(
      initialSessionLoadPhase({ agentSeat: false, sessionId: "x" }),
    ).toBe("attaching");
  });

  it("agent with pin resumes; without pin starts new; blank pin finds", () => {
    expect(
      initialSessionLoadPhase({ agentSeat: true, sessionId: "abc" }),
    ).toBe("resuming");
    expect(initialSessionLoadPhase({ agentSeat: true })).toBe("starting");
    expect(initialSessionLoadPhase({ agentSeat: true, sessionId: "  " })).toBe(
      "finding",
    );
  });
});

describe("isSessionLoadActive", () => {
  it("treats null as inactive", () => {
    expect(isSessionLoadActive(null)).toBe(false);
    expect(isSessionLoadActive("attaching")).toBe(true);
  });
});
