import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { isCiSourcePackage } from "../scripts/source-package-mode";

describe("CI source package boundary", () => {
  it("requires an explicit CI mode", () => {
    expect(isCiSourcePackage({})).toBe(false);
    expect(() => isCiSourcePackage({ JUNTO_CI_SOURCE_PACKAGE: "1" })).toThrow(/CI=true/);
    expect(isCiSourcePackage({ CI: "true", JUNTO_CI_SOURCE_PACKAGE: "1" })).toBe(true);
  });

  it.each(["--sign", "--notarize", "--verify"])("refuses the release option %s before compilation", option => {
    const result = spawnSync("bash", ["scripts/build-app.sh", "--ci-source-package", option, "--preflight-only"], { encoding: "utf8", env: { ...process.env, CI: "true" } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("never the release lane");
  });

  it("admits an unsigned CI preflight and refuses the same option outside CI", () => {
    const args = ["scripts/build-app.sh", "--ci-source-package", "--fast", "--preflight-only"];
    const admitted = spawnSync("bash", args, { encoding: "utf8", env: { ...process.env, CI: "true" } });
    expect(admitted.status).toBe(0);
    const refused = spawnSync("bash", args, { encoding: "utf8", env: { ...process.env, CI: "false" } });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("unsigned CI source packages");
  });
});
