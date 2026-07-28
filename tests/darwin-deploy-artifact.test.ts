import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRemoteDeployScript,
  darwinLiveWorkRefusalResult,
  validateReleaseZipArtifactInput,
} from "../src/main/vellum/hosts/deploy-darwin";
import { REMOTE_UPDATE_IDLE_PRODUCT_COPY } from "../src/shared/remote-update-status";

const TEST_CDHASH = "0123456789abcdef0123456789abcdef01234567";
const SHA = "a".repeat(64);

describe("validateReleaseZipArtifactInput", () => {
  it("admits a canonical absolute zip path + sha256", () => {
    expect(
      validateReleaseZipArtifactInput({
        zipPath: "/tmp/release/Vellum Command-0.1.0-arm64-mac.zip",
        sha256: SHA,
        version: "0.1.0",
      }),
    ).toEqual({
      zipPath: "/tmp/release/Vellum Command-0.1.0-arm64-mac.zip",
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
  it("defaults to app-tar and omits archive digest vars", () => {
    const script = buildRemoteDeployScript("/Users/op", TEST_CDHASH);
    expect(script).toContain("ARTIFACT_KIND=app-tar");
    expect(script).not.toContain("EXPECTED_ARCHIVE_SHA256=");
    expect(script).toContain('"$TAR" -C "$IN/$BUNDLE" -xf -');
  });

  it("emits release-zip extract path with expected archive digest", () => {
    const script = buildRemoteDeployScript("/Users/op", TEST_CDHASH, {
      kind: "release-zip",
      expectedArchiveSha256: SHA,
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
      }),
    ).toThrow(/sha256/i);
  });
});

describe("darwinLiveWorkRefusalResult", () => {
  it("defers with product copy when terminal sessions are active", () => {
    const result = darwinLiveWorkRefusalResult({
      hostLabel: "studio",
      stages: ["probed"],
      version: "0.1.0",
      refusal: {
        acquired: false,
        reason: "active-terminal-sessions",
        evidence: {
          activeTerminalSessions: 2,
          observationId: "obs-1",
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.disposition).toBe("not-started");
    expect(result.code).toBe("conflict");
    expect(result.detail).toContain(REMOTE_UPDATE_IDLE_PRODUCT_COPY);
    expect(result.recoveryAction).toEqual({
      kind: "close-active-vellum-terminals",
      activeTerminalSessions: 2,
    });
  });

  it("does not claim force-close for maintenance-held", () => {
    const result = darwinLiveWorkRefusalResult({
      hostLabel: "studio",
      stages: [],
      refusal: {
        acquired: false,
        reason: "maintenance-held",
        evidence: {
          activeTerminalSessions: 0,
          observationId: "obs-2",
        },
      },
    });
    expect(result.recoveryAction).toEqual({
      kind: "restore-terminal-live-work-observation",
    });
    expect(result.detail).toContain("terminal route cut");
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
