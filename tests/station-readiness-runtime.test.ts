import { describe, expect, it } from "vitest";
import { supervisorAlignedForReadiness } from "../src/main/runtime";

describe("station readiness runtime facts", () => {
  it.each([
    ["remote", true, "installed", true],
    ["remote", true, "absent", false],
    ["remote", true, "unknown", false],
    ["remote", false, "absent", true],
    ["remote", false, "installed", false],
    ["command-center", false, "absent", true],
    ["command-center", false, "installed", false],
    ["command-center", false, "unknown", true],
  ] as const)(
    "aligns role %s / preference %s with observed provider %s",
    (role, supervisedPreferred, supervisedInstalled, expected) => {
      expect(
        supervisorAlignedForReadiness({
          role,
          hostId: "studio",
          supervisedPreferred,
          supervisedInstalled,
        }),
      ).toBe(expected);
    },
  );
});
