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

  it("finds the seat, then says it is starting, however it picks up", () => {
    expect(sessionLoadPresentation({ phase: "finding" }).label).toBe("finding the seat");
    expect(sessionLoadPresentation({ phase: "starting" }).label).toBe("starting");
  });
});

describe("initialSessionLoadPhase", () => {
  it("non-agent shells go straight to attaching", () => {
    expect(
      initialSessionLoadPhase({ agentSeat: false }),
    ).toBe("attaching");
  });

  it("finds the seat on its machine before it starts", () => {
    expect(initialSessionLoadPhase({ agentSeat: true })).toBe("finding");
  });
});

describe("isSessionLoadActive", () => {
  it("treats null as inactive", () => {
    expect(isSessionLoadActive(null)).toBe(false);
    expect(isSessionLoadActive("attaching")).toBe(true);
  });
});
