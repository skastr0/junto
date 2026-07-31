import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  managedBundleRelativeDestination,
  parseQualificationArgs,
  qualificationMachineNames,
  requireRunId,
} from "../scripts/linux-orbstack-two-station-qualification";

const SCRIPT = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "../scripts/linux-orbstack-two-station-qualification.ts",
);

describe("Linux OrbStack two-station qualification (userland archive)", () => {
  it("parses prepare args without a privileged package path", () => {
    const options = parseQualificationArgs([
      "prepare",
      "--run-id",
      "release-015",
      "--evidence-dir",
      "/tmp/vellum-evidence",
      "--golden-vm",
      "vellum-ubuntu-x64-golden",
      "--golden-id",
      "01QUALIFICATIONGOLDEN000000000",
      "--kind",
      "qualification-candidate",
      "--bundle",
      "/tmp/bundle",
      "--source-commit",
      "a".repeat(40),
    ]);
    expect(options).toMatchObject({
      mode: "prepare",
      runId: "release-015",
      goldenName: "vellum-ubuntu-x64-golden",
      kind: "qualification-candidate",
      bundleDirectory: "/tmp/bundle",
    });
    expect(options).not.toHaveProperty("debPath");
  });

  it("rejects unknown privileged flags", () => {
    expect(() =>
      parseQualificationArgs([
        "prepare",
        "--run-id",
        "release-015",
        "--evidence-dir",
        "/tmp/vellum-evidence",
        "--deb",
        "/tmp/app.deb",
      ]),
    ).toThrow(/unknown option|--deb/u);
  });

  it("names disposable VMs from the run id", () => {
    expect(qualificationMachineNames("release-015")).toEqual({
      commandCenter: "vellum-q-release-015-cc",
      remote: "vellum-q-release-015-remote",
    });
    expect(requireRunId("release-015")).toBe("release-015");
  });

  it("stages the managed bundle under the owner-home release cache", () => {
    expect(managedBundleRelativeDestination("qualification-candidate")).toBe(
      ".vellum/releases/linux-x64-glibc/qualification/current/",
    );
    expect(managedBundleRelativeDestination("final-release")).toBe(
      ".vellum/releases/linux-x64-glibc/current/",
    );
  });

  it("contains no privileged install lane in the qualification runner", () => {
    const source = readFileSync(SCRIPT, "utf8");
    expect(source).not.toMatch(/\/usr\/bin\/dpkg(?:-query)?\b/u);
    expect(source).not.toMatch(/\/usr\/bin\/apt-get\b/u);
    expect(source).not.toMatch(/\/opt\/Vellum Command\b/u);
    expect(source).not.toMatch(/vellum-release-bridge|vellum-release-installer/u);
    expect(source).not.toMatch(/admin-password|passwordless sudo/u);
    expect(source).toContain("userland");
    expect(source).toContain("renderUserlandLinuxService");
    expect(source).toContain("archiveSha256");
    expect(source).not.toContain("debSha256");
    expect(source).not.toContain("debFile");
  });
});
