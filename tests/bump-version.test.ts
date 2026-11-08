import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  bumpPackageVersion,
  nextVersion,
  parseSemver,
  replacePackageVersion,
} from "../scripts/bump-version";

describe("bump-version", () => {
  it("parses and advances semver", () => {
    expect(parseSemver("0.1.2")).toEqual([0, 1, 2]);
    expect(nextVersion("0.1.2", "patch")).toBe("0.1.3");
    expect(nextVersion("0.1.2", "minor")).toBe("0.2.0");
    expect(nextVersion("0.1.2", "major")).toBe("1.0.0");
    expect(nextVersion("0.1.2", { set: "0.3.0" })).toBe("0.3.0");
  });

  it("rejects non X.Y.Z", () => {
    expect(() => parseSemver("1.0")).toThrow(/invalid semantic version/);
    expect(() => nextVersion("0.1.2", { set: "v1" })).toThrow(/invalid/);
  });

  it("rewrites only the top-level version field", () => {
    const raw = `{\n  "name": "@skastr0/junto",\n  "version": "0.1.2",\n  "dependencies": {\n    "thinking-orbs": "0.1.1"\n  }\n}\n`;
    const next = replacePackageVersion(raw, "0.1.3");
    expect(next).toContain('"version": "0.1.3"');
    expect(next).toContain('"thinking-orbs": "0.1.1"');
  });

  it("bumps a temp package.json and supports dry-run", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "junto-bump-"));
    const packageJsonPath = path.join(dir, "package.json");
    writeFileSync(
      packageJsonPath,
      `{\n  "name": "tmp",\n  "version": "0.1.2"\n}\n`,
      "utf8",
    );

    const dry = bumpPackageVersion({
      packageJsonPath,
      kind: "patch",
      dryRun: true,
    });
    expect(dry).toMatchObject({
      previous: "0.1.2",
      next: "0.1.3",
      dryRun: true,
    });
    expect(JSON.parse(readFileSync(packageJsonPath, "utf8")).version).toBe(
      "0.1.2",
    );

    const wet = bumpPackageVersion({ packageJsonPath, kind: "patch" });
    expect(wet.next).toBe("0.1.3");
    expect(JSON.parse(readFileSync(packageJsonPath, "utf8")).version).toBe(
      "0.1.3",
    );
  });
});
