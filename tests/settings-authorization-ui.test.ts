import { describe, expect, it } from "vitest";
import { isValidLinuxAdministratorPassword } from "../src/renderer/components/SettingsPanel";

describe("Linux administrator authorization password validation", () => {
  it("accepts a non-empty single-line password at the input limit", () => {
    expect(
      isValidLinuxAdministratorPassword("correct horse battery staple"),
    ).toBe(true);
    expect(isValidLinuxAdministratorPassword("a".repeat(256))).toBe(true);
  });

  it.each([
    "",
    "line\nbreak",
    "carriage\rreturn",
    "nul\0byte",
    "a".repeat(257),
  ])("rejects an unsafe local password value", (password) => {
    expect(isValidLinuxAdministratorPassword(password)).toBe(false);
  });
});
