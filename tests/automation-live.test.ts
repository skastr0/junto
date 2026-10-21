import { describe, expect, it } from "vitest";
import { automationMailId } from "../src/main/junto/automation/live";
import { FiringId } from "../src/shared/automation";

describe("automationMailId", () => {
  const firing = FiringId.make("01M5ESKJFC1A88R1MH1NEZWJ30");

  it("is a ULID with the firing's time, the same for the same firing and action", () => {
    const id = automationMailId(firing, 0);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(id.slice(0, 10)).toBe(firing.slice(0, 10));
    expect(automationMailId(firing, 0)).toBe(id);
  });

  it("differs per action and per firing", () => {
    expect(automationMailId(firing, 1)).not.toBe(automationMailId(firing, 0));
    expect(automationMailId(FiringId.make("01M5ESKJFC1A88R1MH1NEZWJ31"), 0)).not.toBe(automationMailId(firing, 0));
  });
});
