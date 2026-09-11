import { describe, expect, it } from "vitest";
import {
  extractKimiSessionIdFromText,
  isKimiSessionId,
} from "../src/main/vellum-command/term/templates/kimi-session";
import { extractSessionIdFromText } from "../src/main/vellum-command/term/session-id-store";
import { KIMI_TEMPLATE } from "../src/shared/managed-terminal-templates";

const SPAWN_CARD = [
  "Session:",
  "No session yet — one will be created on your first message.",
].join("\n");

const FILLED_SESSION = "session_c2da0425-9e75-75e2-bca4-18bff1f2d5cc";
const FILLED_SES = "ses_76a449d0-ea19-46f1-bb89-43316159e948";
const FILLED_UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("kimi session scrape is post-first-message", () => {
  it("the spawn-time welcome card is not an id", () => {
    expect(extractKimiSessionIdFromText(SPAWN_CARD)).toBeUndefined();
    expect(extractKimiSessionIdFromText("Session:\n")).toBeUndefined();
    expect(extractKimiSessionIdFromText("Session:   \n")).toBeUndefined();
    // Generic scrape also needs 8+ chars after Session:, so the blank card
    // is not a startup receipt on either path.
    expect(extractSessionIdFromText(SPAWN_CARD)).toBeUndefined();
  });

  it("a later filled Session: line is a scrape candidate", () => {
    expect(
      extractKimiSessionIdFromText(`Session: ${FILLED_SESSION}`),
    ).toBe(FILLED_SESSION);
    expect(extractKimiSessionIdFromText(`Session: ${FILLED_SES}`)).toBe(
      FILLED_SES,
    );
    expect(extractKimiSessionIdFromText(`Session: ${FILLED_UUID}`)).toBe(
      FILLED_UUID,
    );
  });

  it("chrome words after Session: are not an id", () => {
    expect(extractKimiSessionIdFromText("Session: created")).toBeUndefined();
    expect(extractKimiSessionIdFromText("Session: message")).toBeUndefined();
    expect(
      extractKimiSessionIdFromText("Session: automatically"),
    ).toBeUndefined();
  });

  it("accepts a structured session_id only when it is a Kimi id", () => {
    expect(
      extractKimiSessionIdFromText(`{"session_id":"${FILLED_SES}"}`),
    ).toBe(FILLED_SES);
    expect(
      extractKimiSessionIdFromText('{"session_id":"not-a-kimi-id"}'),
    ).toBeUndefined();
  });

  it("shape-checks live store names", () => {
    expect(isKimiSessionId(FILLED_SESSION)).toBe(true);
    expect(isKimiSessionId(FILLED_SES)).toBe(true);
    expect(isKimiSessionId(FILLED_UUID)).toBe(true);
    expect(isKimiSessionId("ses_7c6b5a49382716")).toBe(true);
    expect(isKimiSessionId("")).toBe(false);
    expect(isKimiSessionId("created")).toBe(false);
  });

  it("template still captures, never pins, and never installs hooks", () => {
    expect(KIMI_TEMPLATE.capabilityBadges.sessionId).toBe("capture");
    expect(KIMI_TEMPLATE.capabilityBadges.hooks).toBe(false);
    expect(KIMI_TEMPLATE.argvSpec.sessionIdFlag).toBeUndefined();
    expect(KIMI_TEMPLATE.probedVersion).toBe("0.34.0");
  });
});
