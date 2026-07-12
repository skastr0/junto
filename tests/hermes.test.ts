import { describe, expect, it } from "vitest";
import { parseProfiles, parseVersion } from "../src/main/vellum/adapters/hermes";

const TABLE = `
 Profile          Model                        Gateway      Alias        Distribution
 ───────────────    ───────────────────────────    ───────────    ───────────    ────────────────────
 ◆default         gpt-5.5                      running      —            —
  profile-13          gpt-5.5                      running      profile-13       —
  profile-14           —                            stopped      —            —
`;

describe("hermes profile parsing", () => {
  it("parses each profile row into name/model/gateway", () => {
    const rows = parseProfiles(TABLE);
    expect(rows).toEqual([
      { name: "default", model: "gpt-5.5", gateway: "running" },
      { name: "profile-13", model: "gpt-5.5", gateway: "running" },
      { name: "profile-14", model: "—", gateway: "stopped" },
    ]);
  });

  it("skips header and separator lines", () => {
    expect(parseProfiles(TABLE).some((r) => r.name.toLowerCase() === "profile")).toBe(false);
  });

  it("extracts the semver from the version banner", () => {
    expect(parseVersion("Hermes Agent v0.18.2 (2026.6.5) · upstream a72bb037")).toBe("v0.18.2");
    expect(parseVersion("no version here")).toBeUndefined();
  });
});
