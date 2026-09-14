import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const script = join(root, "scripts", "notarize-app.sh");
const source = readFileSync(script, "utf8");
const temporaryRoots: string[] = [];

interface NotarizeFixture {
  readonly root: string;
  readonly script: string;
  readonly app: string;
  readonly zip: string;
}

function temporaryRoot(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "vellum-notarize-security.")));
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

function notarizeFixture(): NotarizeFixture {
  const fixtureRoot = temporaryRoot();
  const scripts = join(fixtureRoot, "scripts");
  const release = join(fixtureRoot, "release");
  const app = join(release, "mac-arm64", "Vellum Command.app");
  const executable = join(app, "Contents", "MacOS", "Vellum Command");
  const zip = join(release, "Vellum Command-0.1.0-arm64-mac.zip");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  copyFileSync(script, join(scripts, "notarize-app.sh"));
  copyFileSync(join(root, "scripts", "app-paths.sh"), join(scripts, "app-paths.sh"));
  copyFileSync(join(root, "scripts", "make-mac-dmg.sh"), join(scripts, "make-mac-dmg.sh"));
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  writeFileSync(join(app, "Contents", "Info.plist"), "<plist/>\n");
  writeFileSync(zip, "fixture\n");
  return { root: fixtureRoot, script: join(scripts, "notarize-app.sh"), app, zip };
}

function runNotarize(
  args: string[] | ((fixture: NotarizeFixture) => string[]),
  environment: NodeJS.ProcessEnv | ((fixture: NotarizeFixture) => NodeJS.ProcessEnv) = {},
) {
  const fixture = notarizeFixture();
  const bin = mockRequiredCommands(fixture.root);
  const resolvedArgs = typeof args === "function" ? args(fixture) : args;
  const resolvedEnvironment = typeof environment === "function" ? environment(fixture) : environment;
  const bashEnvironment = join(fixture.root, "bash-env");
  writeFileSync(
    bashEnvironment,
    'function /usr/libexec/PlistBuddy() { printf "%s\\n" "skastr0.vellumcommand"; }\n',
  );
  return spawnSync("/bin/bash", [fixture.script, ...resolvedArgs], {
    cwd: fixture.root,
    env: {
      ...process.env,
      BASH_ENV: bashEnvironment,
      PATH: `${bin}:${process.env.PATH}`,
      ...resolvedEnvironment,
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
    const result = runNotarize([], { VELLUM_COMMAND_RELEASE_DIR: "/tmp/evil\n'PY'\nrm -rf /" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("VELLUM_COMMAND_RELEASE_DIR is not configurable");
  });

  it.each([
    ["CLI app outside release", () => ["--app", "/tmp/evil.app", "--zip", "/tmp/evil.zip"]],
    ["CLI zip outside release", (fixture: NotarizeFixture) => ["--app", fixture.app, "--zip", "/tmp/evil.zip"]],
    ["newline and quote app injection", () => ["--app", "/tmp/evil'\nPY\n.app", "--zip", "/tmp/evil.zip"]],
    ["path traversal app", (fixture: NotarizeFixture) => [
      "--app",
      `${fixture.root}/release/mac-arm64/../mac-arm64/Vellum Command.app`,
      "--zip",
      "/tmp/evil.zip",
    ]],
  ])("refuses %s", (_name, args) => {
    const result = runNotarize(args);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/app must|zip must/);
  });

  it("refuses symlink candidates even when they point at a release artifact", () => {
    const result = runNotarize((fixture) => {
      const link = join(fixture.root, "Vellum Command-0.1.0-arm64-mac.zip");
      symlinkSync(fixture.zip, link);
      return ["--app", fixture.app, "--zip", link];
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("zip must be an existing non-symlink file");
  });

  it("accepts hyphenated production artifactName zip (Vellum-Command-*-mac.zip)", () => {
    // Source-level: both spaced PRODUCT_NAME and locked artifactName forms.
    expect(source).toContain('"${PRODUCT_NAME}-"*-mac.zip');
    expect(source).toContain('"Vellum-Command-"*-mac.zip');

    const result = runNotarize((fixture) => {
      const hyphenZip = join(fixture.root, "release", "Vellum-Command-0.1.0-arm64-mac.zip");
      writeFileSync(hyphenZip, "fixture-hyphen\n");
      return ["--app", fixture.app, "--zip", hyphenZip];
    });
    // Must pass the name check (not "zip must be a Vellum Command macOS release artifact").
    // Full notarize may still fail later (codesign/asc mocks) — only name gate matters.
    expect(result.stderr).not.toContain("zip must be a Vellum Command macOS release artifact");
    if (result.status !== 0) {
      expect(result.stderr).not.toMatch(/zip must be a Vellum Command macOS release artifact/);
    }
  });

  it("refuses wrong zip basenames even as direct release children", () => {
    const result = runNotarize((fixture) => {
      const evil = join(fixture.root, "release", "evil-0.1.0-arm64-mac.zip");
      writeFileSync(evil, "fixture\n");
      return ["--app", fixture.app, "--zip", evil];
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("zip must be a Vellum Command macOS release artifact");
  });

  it("applies the same release-root confinement to ambient source selectors", () => {
    const appOutside = runNotarize([], {
      VELLUM_COMMAND_APP_SRC: "/tmp/outside.app",
      VELLUM_COMMAND_ZIP_SRC: "/tmp/outside.zip",
    });
    expect(appOutside.status).not.toBe(0);
    expect(appOutside.stderr).toContain("app must be an existing non-symlink bundle");

    const zipOutside = runNotarize([], (fixture) => ({
      VELLUM_COMMAND_APP_SRC: fixture.app,
      VELLUM_COMMAND_ZIP_SRC: "/tmp/outside.zip",
    }));
    expect(zipOutside.status).not.toBe(0);
    expect(zipOutside.stderr).toContain("zip must be an existing non-symlink file");
  });

  it("retains source selectors only as validated read authority and records replacement identity checks", () => {
    expect(source).toContain('ENV_ZIP_SOURCE="${VELLUM_COMMAND_ZIP_SRC:-}"');
    expect(source).toContain("unset VELLUM_COMMAND_ZIP_SRC VELLUM_COMMAND_APP_SRC");
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

  it("after staple re-zip, regenerates blockmap and latest-mac.yml from final zip bytes", () => {
    const rezip = source.indexOf('ditto -c -k --keepParent "$app_base" "$STAGED_ZIP"');
    const publishZip = source.indexOf('mv -f "$STAGED_ZIP" "$ZIP_SRC"');
    // Call site (not the function definition) — must run after the stapled zip is published.
    const refreshCall = source.indexOf(
      'refresh_mac_updater_metadata \\\n  "$ZIP_SRC" \\\n  "$BLOCKMAP_PATH"',
    );
    const blockmapPublish = source.indexOf('mv -f "$STAGED_BLOCKMAP" "$BLOCKMAP_PATH"');
    const ymlPublish = source.indexOf('mv -f "$STAGED_LATEST_MAC_YML" "$LATEST_MAC_YML"');
    const helper = source.indexOf("refresh-mac-updater-metadata.mjs");
    expect(rezip).toBeGreaterThanOrEqual(0);
    expect(publishZip).toBeGreaterThan(rezip);
    expect(refreshCall).toBeGreaterThan(publishZip);
    expect(blockmapPublish).toBeGreaterThan(refreshCall);
    expect(ymlPublish).toBeGreaterThan(refreshCall);
    expect(helper).toBeGreaterThanOrEqual(0);
    expect(source).toContain('assert_same_identity "replaced zip blockmap"');
    expect(source).toContain('assert_same_identity "replaced latest-mac.yml"');
    expect(source).toContain("ZIP_SHA512_STAPLED");
    expect(source).toContain("zipSha512Stapled");
  });

  it("clears or refreshes a notarization receipt that does not match admitted bytes", () => {
    const clearFn = source.indexOf("clear_stale_notarization_receipt() {");
    const call = source.indexOf(
      'clear_stale_notarization_receipt "$RECEIPT_PATH" "$ZIP_SHA" "$APP_CDHASH"',
    );
    const submit = source.indexOf("asc notarization submit \\");
    const receiptWrite = source.indexOf('"zipSha256Stapled": sys.argv[7]');
    expect(clearFn).toBeGreaterThanOrEqual(0);
    expect(call).toBeGreaterThan(clearFn);
    expect(submit).toBeGreaterThan(call);
    expect(receiptWrite).toBeGreaterThan(submit);
    expect(source).toContain("clearing stale notarization receipt");
    expect(source).toContain("does not match admitted zip/app bytes");
  });

  it("never lets the metadata helper write durable release paths directly", () => {
    expect(source).toContain('STAGED_BLOCKMAP="$STAGING_DIR/$(basename "$ZIP_SRC").blockmap"');
    expect(source).toContain('STAGED_LATEST_MAC_YML="$STAGING_DIR/latest-mac.yml"');
    expect(source).toContain('--blockmap-out "$staged_blockmap"');
    expect(source).toContain('--yml-out "$staged_yml"');
    expect(source).not.toContain('--blockmap-out "$BLOCKMAP_PATH"');
    expect(source).not.toContain('--yml-out "$LATEST_MAC_YML"');
  });
});
