/**
 * Seat onboarding in the renderer: the store keeps the latest status per
 * binding, refuses what it does not recognize, and the copy the operator
 * reads when a nudge is refused names the reason.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  applySeatOnboardingEvent,
  decodeSeatOnboardingEvent,
  seatOnboarding$,
} from "../src/renderer/lib/seat-onboarding";
import { ManagedPromptRefusalReason } from "../src/shared/managed-prompt";
import { onboardNudgeRefusal, SEAT_ONBOARDING_LABEL } from "../src/shared/seat-onboarding-status";

beforeEach(() => {
  seatOnboarding$.byBindingId.set({});
});

describe("seat onboarding store", () => {
  it("decodes a status event and nothing else", () => {
    expect(decodeSeatOnboardingEvent({ bindingId: "b1", status: "onboarded", at: 5 })).toEqual({
      bindingId: "b1",
      status: "onboarded",
      at: 5,
    });
    expect(decodeSeatOnboardingEvent({ bindingId: "b1", status: "unknown", at: 5 })).toBeUndefined();
    expect(decodeSeatOnboardingEvent({ bindingId: "", status: "onboarded", at: 5 })).toBeUndefined();
    expect(decodeSeatOnboardingEvent({ bindingId: "b1", status: "onboarded" })).toBeUndefined();
    expect(decodeSeatOnboardingEvent(null)).toBeUndefined();
  });

  it("keeps the latest status per seat", () => {
    applySeatOnboardingEvent({ bindingId: "b1", status: "not-onboarded", at: 1 });
    applySeatOnboardingEvent({ bindingId: "b2", status: "not-onboarded", at: 1 });
    applySeatOnboardingEvent({ bindingId: "b1", status: "onboarded", at: 2 });
    expect(seatOnboarding$.byBindingId.b1.peek()?.status).toBe("onboarded");
    expect(seatOnboarding$.byBindingId.b2.peek()?.status).toBe("not-onboarded");
  });

  it("a late snapshot never puts an older status back", () => {
    applySeatOnboardingEvent({ bindingId: "b1", status: "onboarded", at: 9 });
    applySeatOnboardingEvent({ bindingId: "b1", status: "not-onboarded", at: 3 });
    expect(seatOnboarding$.byBindingId.b1.peek()?.status).toBe("onboarded");
  });

  it("a fresh session after an onboarded one shows as not onboarded", () => {
    applySeatOnboardingEvent({ bindingId: "b1", status: "onboarded", at: 3 });
    applySeatOnboardingEvent({ bindingId: "b1", status: "not-onboarded", at: 9 });
    expect(seatOnboarding$.byBindingId.b1.peek()?.status).toBe("not-onboarded");
  });
});

describe("onboarding copy", () => {
  it("names both states", () => {
    expect(SEAT_ONBOARDING_LABEL).toEqual({ onboarded: "Onboarded", "not-onboarded": "Not onboarded" });
  });

  it("every refusal reads as a sentence with no middle dot", () => {
    for (const reason of ManagedPromptRefusalReason.literals) {
      const message = onboardNudgeRefusal(reason);
      expect(message).toMatch(/^[A-Z].*\.$/);
      expect(message).not.toContain("·");
    }
  });

  it("tells a busy seat, a draft and an unreadable composer apart", () => {
    const messages = new Set(
      ["seat-busy", "composer-not-empty", "composer-unreadable", "operator-active"].map(onboardNudgeRefusal),
    );
    expect(messages.size).toBe(4);
  });
});
