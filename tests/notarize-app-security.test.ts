import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const script = join(root, "scripts", "notarize-app.sh");
const source = readFileSync(script, "utf8");
const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "vellum-notarize-security."));
  temporaryRoots.push(directory);
  return directory;
}

function mockRequiredCommands(directory: string): string {
  const bin = join(directory, "bin");
  mkdirSync(bin);
  for (const command of ["asc", "xcrun", "python3", "ditto", "shasum"]) {
    const path = join(bin, command);
    writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    chmodSync(path, 0o700);
  }
  return bin;
}

function runNotarize(args: string[], environment: NodeJS.ProcessEnv = {}) {
  const temp = temporaryRoot();
  const bin = mockRequiredCommands(temp);
  return spawnSync("/bin/bash", [script, ...args], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      ...environment,
    },
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("notarization path capabilities", () => {
  it("has syntactically valid shell and a data-only receipt writer", () => {
    expect(spawnSync("/bin/bash", ["-n", script]).status).toBe(0);
    expect(source).toContain("<<'PY'");
    expect(source).toContain("sys.argv[2]");
    expect(source).not.toContain('pathlib.Path("$RECEIPT_PATH")');
    expect(source).not.toMatch(/python3\s+-\s+"\$RECEIPT_PATH"[^\n]*<<PY/);
  });

  it("refuses ambient release-root mutation authority before loading shared paths", () => {
    const result = runNotarize([], { VELLUM_RELEASE_DIR: "/tmp/evil\n'PY'\nrm -rf /" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("VELLUM_RELEASE_DIR is not configurable");
  });

  it.each([
    ["CLI app outside release", ["--app", "/tmp/evil.app", "--zip", "/tmp/evil.zip"]],
    ["CLI zip outside release", ["--app", join(root, "release/mac-arm64/Vellum Command.app"), "--zip", "/tmp/evil.zip"]],
    ["newline and quote app injection", ["--app", "/tmp/evil'\nPY\n.app", "--zip", "/tmp/evil.zip"]],
    ["path traversal app", ["--app", join(root, "release/mac-arm64/../mac-arm64/Vellum Command.app"), "--zip", "/tmp/evil.zip"]],
  ])("refuses %s", (_name, args) => {
    const result = runNotarize(args);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/app must|zip must/);
  });

  it("refuses symlink candidates even when they point at a release artifact", () => {
    const temp = temporaryRoot();
    const link = join(temp, "Vellum Command-0.1.0-arm64-mac.zip");
    symlinkSync(join(root, "release", "Vellum Command-0.1.0-arm64-mac.zip"), link);
    const result = runNotarize([
      "--app", join(root, "release/mac-arm64/Vellum Command.app"),
      "--zip", link,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("zip must be an existing non-symlink file");
  });

  it("applies the same release-root confinement to ambient source selectors", () => {
    const appOutside = runNotarize([], {
      VELLUM_APP_SRC: "/tmp/outside.app",
      VELLUM_ZIP_SRC: "/tmp/outside.zip",
    });
    expect(appOutside.status).not.toBe(0);
    expect(appOutside.stderr).toContain("app must be an existing non-symlink bundle");

    const zipOutside = runNotarize([], {
      VELLUM_APP_SRC: join(root, "release/mac-arm64/Vellum Command.app"),
      VELLUM_ZIP_SRC: "/tmp/outside.zip",
    });
    expect(zipOutside.status).not.toBe(0);
    expect(zipOutside.stderr).toContain("zip must be an existing non-symlink file");
  });

  it("retains source selectors only as validated read authority and records replacement identity checks", () => {
    expect(source).toContain('ENV_ZIP_SOURCE="${VELLUM_ZIP_SRC:-}"');
    expect(source).toContain("unset VELLUM_ZIP_SRC VELLUM_APP_SRC");
    expect(source).toContain('STAGING_DIR="$(mktemp -d "$RELEASE_ROOT/.notarize-stage.XXXXXXXX")"');
    expect(source).toContain('SUBMITTED_ZIP="$STAGING_DIR/submitted.zip"');
    expect(source).toContain('ditto "$ZIP_SRC" "$SUBMITTED_ZIP"');
    expect(source).toContain('--file "$SUBMITTED_ZIP"');
    expect(source).toContain('assert_same_identity "release zip" "$ZIP_SRC" "$ZIP_ID"');
    expect(source).toContain('assert_same_identity "release app" "$APP_PATH" "$APP_ID"');
    expect(source).toContain('assert_same_identity "release zip" "$ZIP_SRC" "$ZIP_ID"');
    expect(source).toContain('assert_same_identity "replaced release app" "$APP_PATH" "$STAGED_APP_ID"');
    expect(source).toContain('assert_same_identity "replaced release zip" "$ZIP_SRC" "$STAGED_ZIP_ID"');
  });

  it("never opens durable release outputs for tool or Python writes", () => {
    expect(source).toContain('SUBMIT_LOG="$STAGING_DIR/notarization-submit.json"');
    expect(source).toContain('SUBMIT_ERR="$STAGING_DIR/notarization-submit.err"');
    expect(source).toContain('NOTARY_LOG="$STAGING_DIR/notarization-log.json"');
    expect(source).toContain('STAGED_RECEIPT="$STAGING_DIR/notarization-receipt.json"');
    expect(source).toContain('assert_output_unchanged "$SUBMIT_RECEIPT_PATH" "$SUBMIT_RECEIPT_ID"');
    expect(source).toContain('assert_output_unchanged "$RECEIPT_PATH" "$RECEIPT_ID"');
    expect(source).not.toContain('>"$RELEASE_ROOT/notarization-');
    expect(source).not.toContain('>"$RELEASE_DIR/notarization-');
  });

  it("re-verifies the staged bundle identity before any staple operation", () => {
    const copy = source.indexOf('ditto --rsrc "$APP_PATH" "$STAGED_APP"');
    const stagedVerify = source.indexOf('codesign --verify --deep --strict --verbose=2 "$STAGED_APP"');
    const stagedHash = source.indexOf('APP_CDHASH="$STAGED_APP_CDHASH"');
    const staple = source.indexOf('xcrun stapler staple "$STAGED_APP"');
    expect(copy).toBeGreaterThanOrEqual(0);
    expect(stagedVerify).toBeGreaterThanOrEqual(0);
    expect(stagedVerify).toBeGreaterThan(copy);
    expect(stagedHash).toBeGreaterThan(stagedVerify);
    expect(staple).toBeGreaterThan(stagedHash);
  });

  it("hashes and identity-checks the source archive across the private copy", () => {
    const sourceHash = source.indexOf('ZIP_SHA="$(shasum -a 256 "$ZIP_SRC"');
    const copy = source.indexOf('ditto "$ZIP_SRC" "$SUBMITTED_ZIP"');
    const sourceRecheck = source.indexOf('assert_same_identity "release zip" "$ZIP_SRC" "$ZIP_ID"');
    const stagedHash = source.indexOf('submitted zip did not preserve the admitted release content');
    expect(sourceHash).toBeGreaterThanOrEqual(0);
    expect(copy).toBeGreaterThan(sourceHash);
    expect(sourceRecheck).toBeGreaterThan(copy);
    expect(stagedHash).toBeGreaterThan(sourceRecheck);
  });
});
