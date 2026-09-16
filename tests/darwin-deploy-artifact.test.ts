import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  buildRemoteDeployScript,
  compileExpectedPackageState,
  validateReleaseZipArtifactInput,
} from "../src/main/junto/hosts/deploy-darwin";

vi.hoisted(() => {
  vi.stubGlobal("__JUNTO_MAC_TEAM_ID__", "EXAMP12345");
  vi.stubGlobal("__JUNTO_MAC_SIGNING_IDENTITY__", "Developer ID Application: Example Maintainer (EXAMP12345)");
});
afterAll(() => vi.unstubAllGlobals());

const TEST_CDHASH = "0123456789abcdef0123456789abcdef01234567";
const SHA = "a".repeat(64);

describe("validateReleaseZipArtifactInput", () => {
  it("admits a canonical absolute zip path + sha256", () => {
    expect(
      validateReleaseZipArtifactInput({
        zipPath: "/tmp/release/Junto-0.1.0-arm64-mac.zip",
        sha256: SHA,
        version: "0.1.0",
      }),
    ).toEqual({
      zipPath: "/tmp/release/Junto-0.1.0-arm64-mac.zip",
      sha256: SHA,
      version: "0.1.0",
    });
  });

  it.each([
    ["relative path", { zipPath: "rel.zip", sha256: SHA }],
    ["not zip", { zipPath: "/tmp/app.dmg", sha256: SHA }],
    ["bad digest", { zipPath: "/tmp/a.zip", sha256: "nope" }],
    ["empty version pin", { zipPath: "/tmp/a.zip", sha256: SHA, version: "  " }],
  ])("refuses %s", (_label, input) => {
    expect(() => validateReleaseZipArtifactInput(input)).toThrow();
  });

  it("normalizes sha256 to lowercase", () => {
    const upper = "B".repeat(64);
    expect(
      validateReleaseZipArtifactInput({
        zipPath: "/tmp/a.zip",
        sha256: upper,
      }).sha256,
    ).toBe(upper.toLowerCase());
  });
});

describe("buildRemoteDeployScript release-zip transfer", () => {
  it("emits app-tar without archive digest vars", () => {
    const script = buildRemoteDeployScript("/Users/op", TEST_CDHASH, {
      kind: "app-tar",
      expectedPackageState: "present",
    });
    expect(script).toContain("ARTIFACT_KIND=app-tar");
    expect(script).toContain("EXPECTED_PACKAGE_STATE='present'");
    expect(script).not.toContain("EXPECTED_ARCHIVE_SHA256=");
    expect(script).toContain('"$TAR" -C "$IN/$BUNDLE" -xf -');
  });

  it("binds a first-install decision to the serialized remote transaction", () => {
    const script = buildRemoteDeployScript("/Users/op", TEST_CDHASH, {
      kind: "app-tar",
      expectedPackageState: "absent",
    });
    expect(script).toContain("EXPECTED_PACKAGE_STATE='absent'");
    expect(script).toContain("PACKAGE_STATE_CHANGED_BEFORE_DEPLOY");
    expect(
      script.indexOf('if [ "$EXPECTED_PACKAGE_STATE" = "absent" ]'),
    ).toBeGreaterThan(script.indexOf("LOCK_HELD=1"));
  });

  it("emits release-zip extract path with expected archive digest", () => {
    const script = buildRemoteDeployScript("/Users/op", TEST_CDHASH, {
      kind: "release-zip",
      expectedArchiveSha256: SHA,
      expectedPackageState: "present",
    });
    expect(script).toContain("ARTIFACT_KIND=release-zip");
    expect(script).toContain(`EXPECTED_ARCHIVE_SHA256='${SHA}'`);
    expect(script).toContain('"$DITTO" -x -k "$ARCHIVE" "$IN"');
    expect(script).toContain("INCOMING_ARCHIVE_DIGEST_MISMATCH");
    expect(script).toContain(`EXPECTED_CDHASH='${TEST_CDHASH}'`);
  });

  it("refuses malformed archive sha256", () => {
    expect(() =>
      buildRemoteDeployScript("/Users/op", TEST_CDHASH, {
        kind: "release-zip",
        expectedArchiveSha256: "zz",
        expectedPackageState: "present",
      }),
    ).toThrow(/sha256/i);
  });
});

describe("expected package state compilation", () => {
  it("station applied compiles present even when the package is gone", () => {
    expect(compileExpectedPackageState("absent", "present")).toBe("present");
    expect(compileExpectedPackageState("absent")).toBe("absent");
    expect(compileExpectedPackageState("unknown")).toBe("present");
    const script = buildRemoteDeployScript("/Users/op", TEST_CDHASH, {
      kind: "app-tar",
      expectedPackageState: compileExpectedPackageState("absent", "present"),
    });
    expect(script).not.toContain("--vellum-headless");
    expect(script).toContain("STATION_READY");
    expect(script).not.toContain("ENROLLMENT_READY");
  });
});

describe("hash fixture for release zip shape", () => {
  it("hashes a temp file to 64 hex for authority tests", () => {
    const dir = mkdtempSync(join(tmpdir(), "vellum-darwin-zip-"));
    try {
      const path = join(dir, "payload.zip");
      writeFileSync(path, "zip-bytes");
      const digest = createHash("sha256").update("zip-bytes").digest("hex");
      expect(digest).toMatch(/^[0-9a-f]{64}$/u);
      expect(path.endsWith(".zip")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
