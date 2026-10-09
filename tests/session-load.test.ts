import { describe, expect, it } from "vitest";
import {
  initialSessionLoadPhase,
  isSessionLoadActive,
  sessionLoadPresentation,
  startedSessionLoadPhase,
} from "../src/renderer/lib/session-load";

describe("sessionLoadPresentation", () => {
  it("maps finding / starting / attaching / stuck to distinct tones", () => {
    expect(sessionLoadPresentation({ phase: "finding" }).tone).toBe("cyan");
    expect(sessionLoadPresentation({ phase: "starting" }).tone).toBe("amber");
    expect(sessionLoadPresentation({ phase: "attaching" }).tone).toBe("cyan");
    expect(sessionLoadPresentation({ phase: "stuck" }).tone).toBe("crimson");
  });

  it("shows a violet resuming label", () => {
    const p = sessionLoadPresentation({
      phase: "resuming",
    });
    expect(p.tone).toBe("violet");
    expect(p.label).toBe("resuming session");
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
      initialSessionLoadPhase({ agentSeat: false }),
    ).toBe("attaching");
  });

  it("finds the machine's session before deciding how to start", () => {
    expect(initialSessionLoadPhase({ agentSeat: true })).toBe("finding");
  });
});

describe("startedSessionLoadPhase", () => {
  it("resumes only when the host resumed a session", () => {
    expect(startedSessionLoadPhase({ resuming: true })).toBe("resuming");
    expect(startedSessionLoadPhase({ resuming: false })).toBe("starting");
  });
});

describe("isSessionLoadActive", () => {
  it("treats null as inactive", () => {
    expect(isSessionLoadActive(null)).toBe(false);
    expect(isSessionLoadActive("attaching")).toBe(true);
  });
});
