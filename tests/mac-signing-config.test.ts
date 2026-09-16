import { describe, expect, it } from "vitest";
import { resolveMacSigningConfig } from "../scripts/mac-signing-config.mjs";

const configured = {
  JUNTO_MAC_TEAM_ID: "EXAMP12345",
  JUNTO_MAC_SIGNING_IDENTITY: "Developer ID Application: Example Maintainer (EXAMP12345)",
};

describe("explicit macOS release signing authority", () => {
  it("resolves an exact expected Developer ID identity independently of an artifact", () => {
    expect(resolveMacSigningConfig(configured)).toEqual({
      teamIdentifier: "EXAMP12345",
      signingIdentity: configured.JUNTO_MAC_SIGNING_IDENTITY,
      builderIdentity: "Example Maintainer (EXAMP12345)",
    });
  });

  it.each([
    {},
    { ...configured, JUNTO_MAC_TEAM_ID: "OTHER12345" },
    { ...configured, JUNTO_MAC_SIGNING_IDENTITY: "-" },
    { ...configured, JUNTO_MAC_SIGNING_IDENTITY: "Developer ID Application: Example\nMaintainer (EXAMP12345)" },
  ])("refuses absent, mismatched, ad-hoc, or malformed release authority", (environment) => {
    expect(() => resolveMacSigningConfig(environment)).toThrow();
  });
});
