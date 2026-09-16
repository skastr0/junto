import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  buildRemoteDeployScript,
  buildRemoteDeployScriptForTest,
  buildRemoteRuntimeActivateScript,
  classifyDeployTransferDisposition,
  describeDeployTransferFailure,
  decodeRemoteHomeDirectoryOutput,
  captureTarStderr,
  awaitTarCloseBounded,
  isSafeRemoteHomePath,
  parseDeployTransferResult,
  parseRuntimeActivateResult,
  resolveLocalAppBundle,
  validateLocalBundleProvenance,
  type RemoteDeployScriptTestRuntime,
  watchTarExit,
} from "../src/main/vellum-command/hosts/deploy-darwin";
import { SshTransferExitError } from "../src/main/vellum-command/ssh/service";

vi.hoisted(() => {
  vi.stubGlobal("__JUNTO_MAC_TEAM_ID__", "EXAMP12345");
  vi.stubGlobal("__JUNTO_MAC_SIGNING_IDENTITY__", "Developer ID Application: Example Maintainer (EXAMP12345)");
});
afterAll(() => vi.unstubAllGlobals());

const TEST_CDHASH = "0123456789abcdef0123456789abcdef01234567";

describe("resolveLocalAppBundle", () => {
  it("returns a string path or null without throwing", () => {
    // In CI / bare checkout there may be no .app; function must stay pure-safe.
    const path = resolveLocalAppBundle();
    expect(path === null || (typeof path === "string" && path.length > 0)).toBe(
      true,
    );
  });
});

describe("validateLocalBundleProvenance", () => {
  const appPath = "/release/Junto.app";
  const executablePath = `${appPath}/Contents/MacOS/Junto`;
  const metadata = [
    `Executable=${executablePath}`,
    "Identifier=skastr0.vellumcommand",
    "CodeDirectory v=20500 flags=0x10000(runtime) hashes=3+7 location=embedded",
    "Signature size=9055",
    `CDHash=${TEST_CDHASH}`,
    "Authority=Developer ID Application: Example Maintainer (EXAMP12345)",
    "Authority=Developer ID Certification Authority",
    "Authority=Apple Root CA",
    "TeamIdentifier=EXAMP12345",
  ].join("\n");

  const valid = (
    overrides: Partial<Parameters<typeof validateLocalBundleProvenance>[0]> = {},
  ): Parameters<typeof validateLocalBundleProvenance>[0] => ({
    appPath,
    executablePath,
    bundleIdentifier: "skastr0.vellumcommand",
    bundleExecutable: "Junto",
    bundleVersion: "0.1.0",
    codesignMetadata: metadata,
    ...overrides,
  });

  it("admits only the pinned bundle, executable, team, and Developer ID receipt", () => {
    expect(validateLocalBundleProvenance(valid())).toEqual({
      appPath,
      bundleIdentifier: "skastr0.vellumcommand",
      bundleExecutable: "Junto",
      version: "0.1.0",
      teamIdentifier: "EXAMP12345",
      signingAuthority:
        "Developer ID Application: Example Maintainer (EXAMP12345)",
      cdHash: TEST_CDHASH,
    });
  });

  it.each([
    ["arbitrary directory", { appPath: "/release/Other.app" }],
    ["wrong bundle", { bundleIdentifier: "evil.vellum" }],
    ["wrong executable", { bundleExecutable: "Other" }],
    ["invalid version", { bundleVersion: "0.1.0 unsafe" }],
    [
      "wrong signed path",
      { codesignMetadata: metadata.replace(executablePath, "/tmp/Other") },
    ],
    [
      "wrong signed identifier",
      { codesignMetadata: metadata.replace("Identifier=skastr0.vellumcommand", "Identifier=evil") },
    ],
    [
      "wrong team",
      { codesignMetadata: metadata.replace("TeamIdentifier=EXAMP12345", "TeamIdentifier=000") },
    ],
    [
      "ad-hoc",
      { codesignMetadata: metadata.replace("0x10000(runtime)", "0x10002(adhoc,runtime)") },
    ],
    [
      "wrong authority",
      { codesignMetadata: metadata.replace("Example Maintainer (EXAMP12345)", "Other (000)") },
    ],
    [
      "duplicate identity",
      { codesignMetadata: `${metadata}\nTeamIdentifier=EXAMP12345` },
    ],
    [
      "invalid code-directory hash",
      { codesignMetadata: metadata.replace(TEST_CDHASH, "not-a-hash") },
    ],
  ])("refuses %s provenance", (_name, overrides) => {
    expect(() => validateLocalBundleProvenance(valid(overrides))).toThrow();
  });
});

describe("parseDeployTransferResult", () => {
  it("recognizes enrollment control readiness (package phase)", () => {
    expect(
      parseDeployTransferResult({
        stdout: "ENROLLMENT_READY pid=4312 station=1",
        stderr: "",
      }),
    ).toMatchObject({
      ok: true,
      phase: "enrollment",
      detail: expect.stringContaining("waiting to join the fleet"),
    });
  });

  it("still recognizes runtime term+browser as package success (legacy activate)", () => {
    expect(
      parseDeployTransferResult({
        stdout: "STATION_READY pid=4312 term=1 browser=1",
        stderr: "",
      }),
    ).toMatchObject({
      ok: true,
      phase: "runtime",
      detail: expect.stringContaining("running on this Mac"),
    });
  });

  it("fails when ENROLLMENT_READY or STATION_READY is missing", () => {
    for (const stdout of [
      "ENROLLMENT_READY station=1",
      "ENROLLMENT_READY pid=0 station=1",
      "STATION_READY term=1 browser=1",
      "STATION_READY pid=0 term=1 browser=1",
      "TERM_SOCK_OK browser=0",
      "",
    ]) {
      expect(
        parseDeployTransferResult({
          stdout,
          stderr: "ENROLLMENT_PARTIAL station=0",
        }),
      ).toMatchObject({
        ok: false,
        detail: expect.stringContaining("ENROLLMENT_PARTIAL"),
      });
    }
  });
});

describe("parseRuntimeActivateResult", () => {
  it("requires STATION_READY with a live pid and both sockets", () => {
    expect(
      parseRuntimeActivateResult({
        stdout: "STATION_READY pid=4312 term=1 browser=1",
        stderr: "",
      }),
    ).toEqual({
      ok: true,
      detail: "Junto is running on this Mac",
    });
  });

  it("fails on empty stdout or ENROLLMENT_PARTIAL", () => {
    expect(
      parseRuntimeActivateResult({
        stdout: "",
        stderr: "",
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseRuntimeActivateResult({
        stdout: "ENROLLMENT_PARTIAL pid=9 station=0",
        stderr: "ENROLLMENT_PARTIAL pid=9 station=0",
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseRuntimeActivateResult({
        stdout: "STATION_READY pid=0 term=1 browser=1",
        stderr: "",
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("buildRemoteDeployScript", () => {
  const script = buildRemoteDeployScript(
    "/Users/remote station",
    TEST_CDHASH,
    { kind: "app-tar", expectedPackageState: "present" },
  );
  const firstInstall = buildRemoteDeployScript(
    "/Users/remote station",
    TEST_CDHASH,
    { kind: "app-tar", expectedPackageState: "absent" },
  );

  it("keeps every destructive remote target fixed to Junto paths", () => {
    expect(script).toContain("APP='/Applications/Junto.app'");
    expect(script).toContain("IN='/Applications/Junto.app.incoming'");
    expect(script).toContain(
      "CLI_EXE='/Applications/Junto.app/Contents/Resources/bin/vellum-command'",
    );
    const admit = readFileSync(
      new URL("../src/main/vellum-command/hosts/deploy-darwin.ts", import.meta.url),
      "utf8",
    );
    expect(admit).toContain("basename(REMOTE_CLI_EXECUTABLE)");
    expect(admit).not.toContain('"vellum-command",');
    expect(script).toContain(
      'test -f "$IN_CLI_EXE" && test ! -L "$IN_CLI_EXE" && test -x "$IN_CLI_EXE"',
    );
    expect(script).not.toContain("IN_STATION_EXE");
    expect(script).not.toContain("IN_BROWSER_EXE");
    expect(script).toContain(
      "TERM_SOCK='/Users/remote station/.junto/term/control.sock'",
    );
    expect(script).toContain(
      "BROWSER_SOCK='/Users/remote station/.junto/browser/control.sock'",
    );
    expect(script).toContain(
      "STATION_SOCK='/Users/remote station/.junto/station/control.sock'",
    );
    expect(script).not.toContain("--vellum-headless");
    expect(firstInstall).toContain("--vellum-headless");
    expect(script).toContain("STATION_READY");
    expect(script).toContain("RUNTIME_SOCKET_TIMEOUT");
    expect(script).not.toContain("ENROLLMENT_READY");
    expect(script).not.toContain("ENROLLMENT_SOCKET_TIMEOUT");
    expect(firstInstall).toContain("ENROLLMENT_READY");
    expect(firstInstall).toContain("ENROLLMENT_SOCKET_TIMEOUT");
    expect(firstInstall).not.toContain("STATION_READY");

    const recursiveRemovals = script
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("/bin/rm -rf"));
    expect(recursiveRemovals).toEqual([
      '/bin/rm -rf -- "$REMOVE_PATH" || return 1',
      '/bin/rm -rf -- "$REMOVE_APP_PATH" || return 1',
    ]);
    expect(script).toContain(
      'same_directory_identity "$REMOVE_PATH" "$REMOVE_IDENTITY" || return 1',
    );
    expect(script).toContain('/bin/rmdir "$DEPLOY_LOCK" || return 1');
    expect(script).not.toContain(
      'remove_bound_directory "$DEPLOY_LOCK" "$LOCK_ID"',
    );
    expect(script).toContain('"$TAR" -C "$IN/$BUNDLE" -xf -');
    expect(script).toContain(
      "DEPLOY_LOCK='/Applications/.junto-deploy.lock'",
    );
    expect(script).toContain("reclaim_abandoned_deploy_lock");
    expect(script).toContain("DEPLOY_STALE_LOCK_RECLAIMED");
    expect(script).toContain("DEPLOY_LOCK_HOLDER=");
    expect(script).toContain(`EXPECTED_CDHASH='${TEST_CDHASH}'`);
    expect(script).toContain("anchor apple generic");
    expect(script).toContain("certificate leaf[subject.OU]");
    expect(script).toContain(
      '"$CODESIGN" --verify --deep --strict --verbose=2 -R "$DEVELOPER_ID_REQUIREMENT"',
    );
    expect(script).toContain("INCOMING_SIGNATURE_VERIFY_FAILED");
    expect(script).toContain('"$LAUNCHCTL" enable "$JOB"');
    const copyOps = readFileSync(
      new URL(
        "../src/main/vellum-command/hosts/host-ops-darwin.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(copyOps).toContain('command: "/usr/bin/tar"');
    expect(copyOps).not.toContain('command: "tar"');
  });

  it("proves the old job and exact executable gone before replacement", () => {
    const validation = script.indexOf(
      '"$CODESIGN" --verify --deep --strict',
    );
    const bootout = script.indexOf('"$LAUNCHCTL" bootout "$JOB"', validation);
    const boundedProof = script.indexOf(
      "if ! wait_until_job_and_executable_gone 30; then",
      bootout,
    );
    const proofFailure = script.indexOf(
      "OLD_GENERATION_STILL_PRESENT",
      boundedProof,
    );
    const socketRemoval = script.indexOf(
      'retire_stale_socket "$TERM_SOCK" "$RETIRED_TERM_SOCKET"',
      proofFailure,
    );
    const activation = script.indexOf(
      "begin_candidate_activation",
      socketRemoval,
    );
    const appTransition = script.indexOf(
      '/bin/mv -n "$APP/Contents" "$RETIRED_APP/Contents"',
      activation,
    );

    expect(validation).toBeGreaterThan(0);
    expect(bootout).toBeGreaterThan(validation);
    expect(script).not.toContain("osascript");
    expect(script).not.toContain("tell application");
    expect(boundedProof).toBeGreaterThan(bootout);
    expect(proofFailure).toBeGreaterThan(boundedProof);
    expect(socketRemoval).toBeGreaterThan(proofFailure);
    expect(activation).toBeGreaterThan(socketRemoval);
    expect(appTransition).toBeGreaterThan(activation);
    expect(script).not.toContain("run_candidate_state_preflight");
    expect(script).not.toContain("--vellum-state-preflight");
    expect(script).toContain(
      'if ! OBSERVED_EXE_PIDS="$(exact_exe_pids)"; then',
    );
    expect(script).toContain('ALL_LSOF_OUTPUT="$("$LSOF" -n -d txt');
    expect(script).not.toMatch(/\b(?:kill|pkill|killall)\b/u);
  });


  it("refuses an exact unsupervised incumbent before issuing a stop request", () => {
    const refusal = script.indexOf(
      "UNSUPERVISED_INCUMBENT_REQUIRES_LAUNCHAGENT",
    );
    const supervisionRace = script.indexOf(
      "INCUMBENT_SUPERVISION_CHANGED_DURING_ADMISSION",
      refusal,
    );
    const stopRequested = script.indexOf(
      "INCUMBENT_STOP_REQUESTED=1",
      supervisionRace,
    );
    const bootout = script.indexOf(
      '"$LAUNCHCTL" bootout "$JOB"',
      stopRequested,
    );

    expect(refusal).toBeGreaterThan(0);
    expect(supervisionRace).toBeGreaterThan(refusal);
    expect(stopRequested).toBeGreaterThan(supervisionRace);
    expect(bootout).toBeGreaterThan(stopRequested);
  });

  it("uses launchd exclusively and requires a distinct executable-backed generation", () => {
    expect(script).toContain('"$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST"');
    expect(script).toContain('"$LAUNCHCTL" kickstart -p "$JOB"');
    expect(script).toContain(
      'if [ -n "$OLD_PID" ] && [ "$NEW_PID" = "$OLD_PID" ]; then',
    );
    expect(script).toContain('exact_exe_has_pid "$NEW_PID"');
    expect(script).not.toContain("/usr/bin/open");
    expect(script).not.toMatch(/^\s*"\$EXE"(?:\s|$)/mu);
  });

  it("cannot accept preexisting or wrong-owner control sockets as ready", () => {
    const termRemoval = script.lastIndexOf(
      'retire_stale_socket "$TERM_SOCK" "$RETIRED_TERM_SOCKET"',
    );
    const browserRemoval = script.lastIndexOf(
      'retire_stale_socket "$BROWSER_SOCK" "$RETIRED_BROWSER_SOCKET"',
    );
    const bootstrap = script.lastIndexOf(
      'if ! "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST"',
    );
    const stationWitness = script.indexOf(
      'socket_owned_by_pid "$STATION_SOCK" "$NEW_PID"',
    );
    const termWitness = script.indexOf(
      'socket_owned_by_pid "$TERM_SOCK" "$NEW_PID"',
    );
    const browserWitness = script.indexOf(
      'socket_owned_by_pid "$BROWSER_SOCK" "$NEW_PID"',
    );

    expect(termRemoval).toBeGreaterThan(0);
    expect(browserRemoval).toBeGreaterThan(termRemoval);
    expect(bootstrap).toBeGreaterThan(browserRemoval);
    // needRestart (present) proves term+browser. Enroll sock wait is first
    // install only — a Remote never owns that door.
    expect(stationWitness).toBe(-1);
    expect(termWitness).toBeGreaterThan(bootstrap);
    expect(browserWitness).toBeGreaterThan(bootstrap);
    const firstStation = firstInstall.indexOf(
      'socket_owned_by_pid "$STATION_SOCK" "$NEW_PID"',
    );
    expect(firstStation).toBeGreaterThan(
      firstInstall.lastIndexOf(
        'if ! "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST"',
      ),
    );
    expect(firstInstall.indexOf('socket_owned_by_pid "$TERM_SOCK"')).toBe(-1);
    expect(firstInstall.indexOf('socket_owned_by_pid "$BROWSER_SOCK"')).toBe(
      -1,
    );
    expect(script).toContain(
      '"$LSOF" -n -a -U -Fp -- "$1"',
    );
    expect(script).not.toContain('if [ -S "$TERM_SOCK" ]');
    expect(script).not.toContain('if [ -S "$BROWSER_SOCK" ]');
    expect(script).toContain(
      'if job_exists && exact_exe_has_pid "$NEW_PID"',
    );
  });

  it("crosses a one-way boundary before launchd can start the candidate", () => {
    const activation = script.lastIndexOf("begin_candidate_activation");
    const oldAppRetirement = script.lastIndexOf(
      '/bin/mv -n "$APP/Contents" "$RETIRED_APP/Contents"',
    );
    const candidateInstall = script.lastIndexOf(
      '/bin/mv -n "$IN/$BUNDLE/Contents" "$APP/Contents"',
    );
    const bootstrap = script.lastIndexOf(
      'if ! "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST"',
    );
    const postActivation = script.slice(activation);

    expect(script).not.toContain("restore_pre_activation");
    expect(script).not.toContain("discard_previous_artifacts");
    expect(script).not.toContain("APP_BACKED_UP");
    expect(script).not.toContain("PLIST_BACKED_UP");
    expect(activation).toBeGreaterThan(0);
    expect(oldAppRetirement).toBeGreaterThan(activation);
    expect(candidateInstall).toBeGreaterThan(activation);
    expect(bootstrap).toBeGreaterThan(activation);
    expect(postActivation).not.toMatch(
      /\/bin\/mv[^\n]*"\$RETIRED_APP[^\n]*"\$APP/u,
    );
    expect(postActivation).not.toMatch(
      /\/bin\/mv[^\n]*"\$RETIRED_PLIST[^\n]*"\$PLIST/u,
    );
  });

  it("uses denial-only collision guards and exclusively binds every control write", () => {
    expect(script).toContain(
      'echo "UNBOUND_DEPLOY_PATH_PRESENT $UNBOUND_PATH" >&2',
    );
    expect(script).not.toMatch(
      /\/bin\/(?:rm|mv)[^\n]*"\$FORBIDDEN_(?:APP|PLIST)_(?:PREVIOUS|REJECTED)"/u,
    );
    expect(script).toContain('if { exec 9> "$DEPLOY_LOCK_OWNER"; }; then');
    expect(script).toContain(
      'LOCK_OWNER_ID="$(owned_file_identity "$DEPLOY_LOCK_OWNER"',
    );
    expect(script).toContain('if { exec 8> "$PLIST_IN"; }; then');
    expect(script).toContain(
      'PLIST_IN_ID="$(owned_file_identity "$PLIST_IN"',
    );
    expect(script).not.toContain("LSOF_ERROR=");
  });

  it("quotes shell-active home characters and rejects non-canonical homes", () => {
    const shellActive = buildRemoteDeployScript(
      "/Users/remote$(touch should-not-run)",
      TEST_CDHASH,
      { kind: "app-tar", expectedPackageState: "present" },
    );
    expect(shellActive).toContain(
      "TERM_SOCK='/Users/remote$(touch should-not-run)/.junto/term/control.sock'",
    );
    const apostrophe = buildRemoteDeployScript(
      "/Users/o'malley",
      TEST_CDHASH,
      { kind: "app-tar", expectedPackageState: "present" },
    );
    expect(apostrophe).toContain(
      `TERM_SOCK='/Users/o'"'"'malley/.junto/term/control.sock'`,
    );

    expect(isSafeRemoteHomePath("/Users/remote station")).toBe(true);
    for (const home of [
      "",
      "/",
      "Users/remote",
      "/Users/../Applications",
      "/Users/./remote",
      "/Users//remote",
      "/Users/remote/",
      "/Users/remote\nnext",
    ]) {
      expect(isSafeRemoteHomePath(home)).toBe(false);
      expect(() =>
        buildRemoteDeployScript(home, TEST_CDHASH, {
          kind: "app-tar",
          expectedPackageState: "present",
        }),
      ).toThrow("canonical absolute path");
    }
  });

  it("decodes exactly one canonical home record with one LF terminator", () => {
    expect(decodeRemoteHomeDirectoryOutput("/Users/remote station\n")).toBe(
      "/Users/remote station",
    );
    for (const output of [
      "/Users/remote",
      "/Users/remote\r\n",
      "/Users/remote\n\n",
      "/Users/remote\n/Users/other\n",
      " /Users/remote\n",
      "/Users/remote \n",
      "/Users/../Applications\n",
    ]) {
      expect(decodeRemoteHomeDirectoryOutput(output)).toBeNull();
    }
  });
});

describe("remote deploy transaction behavior", () => {
  const makeHarness = (
    expectedPackageState: "absent" | "present" = "present",
    installedPackageState: "absent" | "present" = "present",
  ) => {
    const root = mkdtempSync("/tmp/vellum-deploy-test-");
    const bin = join(root, "bin");
    const state = join(root, "state");
    const remoteHome = join(root, "Users", "remote");
    const appPath = join(root, "Applications", "Junto.app");
    const executablePath = join(
      appPath,
      "Contents",
      "MacOS",
      "Junto",
    );
    const plistPath = join(
      remoteHome,
      "Library",
      "LaunchAgents",
      "skastr0.vellumcommand.plist",
    );
    const termSocketPath = join(
      remoteHome,
      ".junto",
      "term",
      "control.sock",
    );
    mkdirSync(bin, { recursive: true });
    mkdirSync(state, { recursive: true });
    mkdirSync(dirname(appPath), { recursive: true });
    mkdirSync(join(remoteHome, "Library", "LaunchAgents"), {
      recursive: true,
    });
    if (installedPackageState === "present") {
      mkdirSync(join(appPath, "Contents", "MacOS"), { recursive: true });
      mkdirSync(join(appPath, "Contents", "Resources"), { recursive: true });
      writeFileSync(executablePath, "old-generation", { mode: 0o755 });
      writeFileSync(join(appPath, "Contents", "Info.plist"), "old-info");
      writeFileSync(plistPath, "old-plist");
      writeFileSync(join(state, "loaded"), "1");
      writeFileSync(join(state, "pid"), "100\n");
    }

    const executable = (name: string, body: string): string => {
      const path = join(bin, name);
      writeFileSync(path, `#!/bin/bash\nset -euo pipefail\n${body}\n`);
      chmodSync(path, 0o755);
      return path;
    };
    const commands = {
      uname: executable("uname", 'echo "Darwin"'),
      id: executable(
        "id",
        'if [ "${1:-}" = "-un" ]; then echo "remote"; else /usr/bin/id -u; fi',
      ),
      env: executable(
        "env",
        [
          '# env shim: support env -i KEY=val ... cmd args',
          'args=("$@")',
          'if [ "${args[0]:-}" = "-i" ]; then',
          '  shift',
          '  clean_env=()',
          '  while [ "$#" -gt 0 ]; do',
          '    case "$1" in',
          '      *=*) clean_env+=("$1"); shift ;;',
          '      *) break ;;',
          '    esac',
          '  done',
          '  /usr/bin/env -i "${clean_env[@]}" "$@"',
          '  exit $?',
          'fi',
          'exec "$@"',
        ].join("\n"),
      ),
      launchctl: executable(
        "launchctl",
        [
          'echo "$1" >> "$FAKE_STATE/launchctl.log"',
          'case "$1" in',
          '  print) test -f "$FAKE_STATE/loaded" ;;',
          "  kickstart)",
          '    generation="$(cat "$FAKE_EXE" 2>/dev/null || echo missing)"',
          '    printf \'%s\\n\' "$generation" >> "$FAKE_STATE/launched-generations.log"',
          '    if [ "$FAKE_CANDIDATE_KICKSTART_FAIL" = "1" ] && [ "$generation" = "new-generation" ]; then exit 44; fi',
          '    test -f "$FAKE_STATE/loaded"; cat "$FAKE_STATE/pid"',
          "    ;;",
          "  bootout)",
          '    rm -f "$FAKE_STATE/loaded" "$FAKE_STATE/pid"',
          "    ;;",
          "  bootstrap|load) touch \"$FAKE_STATE/loaded\"; printf '200\\n' > \"$FAKE_STATE/pid\" ;;",
          "  *) exit 2 ;;",
          "esac",
        ].join("\n"),
      ),
      lsof: executable(
        "lsof",
        [
          "is_pid=0",
          "is_socket=0",
          'socket_path="${@: -1}"',
          'for arg in "$@"; do',
          '  if [ "$arg" = "-p" ]; then is_pid=1; fi',
          '  if [ "$arg" = "-U" ]; then is_socket=1; fi',
          "done",
          'if [ "$is_socket" = "1" ]; then',
          '  if [ -n "$FAKE_LIVE_SOCKET" ] && [ "$socket_path" = "$FAKE_LIVE_SOCKET" ]; then',
          "    printf 'p999\\n'",
          "    exit 0",
          "  fi",
          "  exit 1",
          "fi",
          'if [ "$is_pid" = "0" ] && [ "$FAKE_LSOF_GLOBAL_ERROR" = "1" ]; then',
          '  echo "observer failed" >&2',
          "  exit 1",
          "fi",
          'if [ -f "$FAKE_STATE/loaded" ]; then',
          '  pid="$(cat "$FAKE_STATE/pid")"',
          "else",
          '  pid="$FAKE_UNSUPERVISED_PID"',
          "fi",
          'test -n "$pid" || exit 0',
          'if [ "$is_pid" = "1" ]; then',
          '  requested=""',
          '  previous=""',
          '  for arg in "$@"; do',
          '    if [ "$previous" = "-p" ]; then requested="$arg"; fi',
          '    previous="$arg"',
          "  done",
          '  [ "$requested" = "$pid" ] || exit 1',
          "fi",
          "printf 'p%s\\nftxt\\nn%s\\n' \"$pid\" \"$FAKE_EXE\"",
        ].join("\n"),
      ),
      uuidgen: executable("uuidgen", 'echo "test-lock-token"'),
      tar: executable(
        "tar",
        [
          'target=""',
          'previous=""',
          'for arg in "$@"; do',
          '  if [ "$previous" = "-C" ]; then target="$arg"; fi',
          '  previous="$arg"',
          "done",
          'test -n "$target"',
          'mkdir -p "$target/Contents/MacOS" "$target/Contents/Resources/bin"',
          "printf 'new-generation' > \"$target/Contents/MacOS/Junto\"",
          'chmod 755 "$target/Contents/MacOS/Junto"',
          'if [ "$FAKE_MISSING_CONTROL_HELPER" != "cli" ]; then',
          "  printf 'cli-helper' > \"$target/Contents/Resources/bin/vellum-command\"",
          '  chmod 755 "$target/Contents/Resources/bin/vellum-command"',
          "fi",
          "printf 'new-info' > \"$target/Contents/Info.plist\"",
          'touch "$FAKE_STATE/tar-ran"',
        ].join("\n"),
      ),
      ditto: executable(
        "ditto",
        [
          'touch "$FAKE_STATE/ditto-ran"',
          'exit 1',
        ].join("\n"),
      ),
      shasum: executable(
        "shasum",
        'echo "0000000000000000000000000000000000000000000000000000000000000000  -"',
      ),
      codesign: executable(
        "codesign",
        [
          'target="${@: -1}"',
          'if [ "$FAKE_EXISTING_APP_INVALID" = "1" ] && [ "$target" = "$FAKE_APP" ]; then exit 1; fi',
          'if [ "$FAKE_CODESIGN_FAIL" = "1" ]; then exit 1; fi',
          'if [ "$1" = "-d" ]; then',
          '  echo "Executable=$target/Contents/MacOS/Junto" >&2',
          '  echo "Identifier=skastr0.vellumcommand" >&2',
          '  echo "CodeDirectory v=20500 flags=0x10000(runtime)" >&2',
          '  echo "Signature size=9055" >&2',
          '  echo "Authority=Developer ID Application: Example Maintainer (EXAMP12345)" >&2',
          '  echo "Authority=Developer ID Certification Authority" >&2',
          '  echo "Authority=Apple Root CA" >&2',
          '  echo "TeamIdentifier=EXAMP12345" >&2',
          '  echo "CDHash=$FAKE_REMOTE_CDHASH" >&2',
          "fi",
        ].join("\n"),
      ),
      find: executable(
        "find",
        [
          'target="$1"',
          'if [ "$FAKE_SWAP_APP_CONTENTS" = "1" ] && [ "$target" = "$FAKE_APP" ]; then',
          '  count_path="$FAKE_STATE/app-find-count"',
          '  count="$(cat "$count_path" 2>/dev/null || echo 0)"',
          "  count=$((count + 1))",
          '  printf \'%s\\n\' "$count" > "$count_path"',
          '  if [ "$count" = "2" ]; then',
          '    /bin/mv "$target/Contents" "$FAKE_STATE/admitted-contents"',
          '    /bin/mkdir "$target/Contents"',
          '    printf \'foreign\' > "$target/Contents/foreign-marker"',
          "  fi",
          "fi",
          'exec /usr/bin/find "$@"',
        ].join("\n"),
      ),
      plutil: executable(
        "plutil",
        [
          'target="${@: -1}"',
          'case "$*" in',
          '  *CFBundleIdentifier*) echo "skastr0.vellumcommand" ;;',
          '  *CFBundleExecutable*) echo "Junto" ;;',
          '  *ProgramArguments.2*) exit 1 ;;',
          '  *ProgramArguments.1*)',
          expectedPackageState === "absent"
            ? '    echo "--vellum-headless" ;;'
            : "    exit 1 ;;",
          '  *ProgramArguments.0*)',
          '    if [ "$FAKE_EXISTING_PLIST_INVALID" = "1" ] && [ "$target" = "$FAKE_PLIST" ]; then echo "/unowned/executable"; else echo "$FAKE_EXE"; fi',
          "    ;;",
          '  *Label*)',
          '    if [ "$FAKE_EXISTING_PLIST_INVALID" = "1" ] && [ "$target" = "$FAKE_PLIST" ]; then echo "unowned.label"; else echo "skastr0.vellumcommand"; fi',
          "    ;;",
          "  *) exit 1 ;;",
          "esac",
        ].join("\n"),
      ),
      stat: executable(
        "stat",
        [
          'if [ "$(/usr/bin/uname -s)" = "Darwin" ]; then exec /usr/bin/stat "$@"; fi',
          // Emulate BSD `stat -f '%d:%i:%u:%HT'` on GNU stat. The deploy
          // script compares the %u field against `id -u` (the fake id shim),
          // so report that same uid instead of the sandbox file owner's.
          'target="${@: -1}"',
          'uid="$("$(dirname "$0")/id" -u)"',
          'dev_inode="$(/usr/bin/stat -c \'%d:%i\' -- "$target")"',
          'kind="$(/usr/bin/stat -c \'%F\' -- "$target")"',
          'case "$kind" in',
          '  directory) kind="Directory" ;;',
          '  regular*) kind="Regular File" ;;',
          '  socket) kind="Socket" ;;',
          '  *) kind="Unsupported" ;;',
          "esac",
          'printf \'%s:%s:%s\\n\' "$dev_inode" "$uid" "$kind"',
        ].join("\n"),
      ),
      sleep: executable("sleep", "exit 0"),
    } satisfies RemoteDeployScriptTestRuntime["commands"];

    const runtime: RemoteDeployScriptTestRuntime = {
      testOnly: true,
      appPath,
      lockPath: join(root, "Applications", ".deploy.lock"),
      commands,
    };
    const script = buildRemoteDeployScriptForTest(
      remoteHome,
      TEST_CDHASH,
      runtime,
      { kind: "app-tar", expectedPackageState },
    );
    const run = (overrides: NodeJS.ProcessEnv = {}) =>
      spawnSync("/bin/bash", ["-c", script], {
        encoding: "utf8",
        // Pure hang-safety net (the script's own retry bound is iteration-count,
        // not wall-clock — `sleep` is stubbed to exit 0). 30s gives headroom
        // under full-suite subprocess contention over the prior 15s, which
        // raced the surrounding vitest test timeout.
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          FAKE_STATE: state,
          FAKE_EXE: executablePath,
          FAKE_CODESIGN_FAIL: "0",
          FAKE_REMOTE_CDHASH: TEST_CDHASH,
          FAKE_LSOF_GLOBAL_ERROR: "0",
          FAKE_CANDIDATE_KICKSTART_FAIL: "0",
          FAKE_MISSING_CONTROL_HELPER: "none",
          FAKE_EXISTING_APP_INVALID: "0",
          FAKE_EXISTING_PLIST_INVALID: "0",
          FAKE_LIVE_SOCKET: "",
          FAKE_SWAP_APP_CONTENTS: "0",
          FAKE_UNSUPERVISED_PID: "",
          FAKE_APP: appPath,
          FAKE_PLIST: plistPath,
          ...overrides,
        },
      });
    return {
      root,
      state,
      appPath,
      executablePath,
      plistPath,
      termSocketPath,
      runtime,
      run,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  };

  // Every it() below shares makeHarness()'s real /bin/bash spawnSync (many
  // real subprocesses per run). The vitest default 5s per-test timeout races
  // that under full-suite subprocess contention; give the same headroom as
  // the harness's own 30s hang-safety net.
  it(
    "validates the transferred signature before stopping the old job",
    () => {
      const harness = makeHarness();
      try {
        const result = harness.run({ FAKE_CODESIGN_FAIL: "1" });
        const launchctlLogPath = join(harness.state, "launchctl.log");
        const launchctlLog = existsSync(launchctlLogPath)
          ? readFileSync(launchctlLogPath, "utf8")
          : "";
        expect(result.status).not.toBe(0);
        expect(readFileSync(harness.executablePath, "utf8")).toBe(
          "old-generation",
        );
        expect(launchctlLog).not.toContain("bootout");
        expect(existsSync(join(harness.state, "loaded"))).toBe(true);
      } finally {
        harness.cleanup();
      }
    },
    35_000,
  );

  it(
    "refuses a fresh candidate missing the packaged CLI before stopping the old job",
    () => {
      const harness = makeHarness();
      try {
        const result = harness.run({
          FAKE_MISSING_CONTROL_HELPER: "cli",
        });
        const launchctlLogPath = join(harness.state, "launchctl.log");
        const launchctlLog = existsSync(launchctlLogPath)
          ? readFileSync(launchctlLogPath, "utf8")
          : "";
        expect(result.status, result.stderr).toBe(12);
        expect(result.stderr).toContain("DEPLOY_NOT_STARTED");
        expect(launchctlLog).not.toContain("bootout");
        expect(readFileSync(harness.executablePath, "utf8")).toBe(
          "old-generation",
        );
      } finally {
        harness.cleanup();
      }
    },
    35_000,
  );

  it(
    "binds the transferred generation to the locally admitted code hash",
    () => {
      const harness = makeHarness();
      try {
        const result = harness.run({
          FAKE_REMOTE_CDHASH: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        });
        const launchctlLogPath = join(harness.state, "launchctl.log");
        const launchctlLog = existsSync(launchctlLogPath)
          ? readFileSync(launchctlLogPath, "utf8")
          : "";
        expect(result.status).toBe(12);
        expect(result.stderr).toContain("REMOTE_SIGNATURE_GENERATION_MISMATCH");
        expect(result.stderr).toContain("DEPLOY_NOT_STARTED");
        expect(launchctlLog).not.toContain("bootout");
        expect(readFileSync(harness.executablePath, "utf8")).toBe(
          "old-generation",
        );
        expect(existsSync(join(harness.state, "loaded"))).toBe(true);
      } finally {
        harness.cleanup();
      }
    },
    35_000,
  );

  it(
    "rejects a first-install transaction if the package becomes present before deploy",
    () => {
      const harness = makeHarness("absent");
      try {
        const result = harness.run();
        const launchctlLogPath = join(harness.state, "launchctl.log");
        const launchctlLog = existsSync(launchctlLogPath)
          ? readFileSync(launchctlLogPath, "utf8")
          : "";
        expect(result.status, result.stderr).toBe(12);
        expect(result.stderr).toContain("PACKAGE_STATE_CHANGED_BEFORE_DEPLOY");
        expect(launchctlLog).not.toContain("bootout");
        expect(existsSync(join(harness.state, "tar-ran"))).toBe(false);
        expect(existsSync(harness.runtime.lockPath)).toBe(false);
        expect(readFileSync(harness.executablePath, "utf8")).toBe(
          "old-generation",
        );
      } finally {
        harness.cleanup();
      }
    },
    35_000,
  );

  it(
    "executes a true first-install transaction without incumbent retirement",
    () => {
      const harness = makeHarness("absent", "absent");
      try {
        const result = harness.run();
        const launchctlLogPath = join(harness.state, "launchctl.log");
        const launchctlLog = existsSync(launchctlLogPath)
          ? readFileSync(launchctlLogPath, "utf8")
          : "";
        expect(result.status, result.stderr).toBe(13);
        expect(result.stderr).toContain("ENROLLMENT_SOCKET_TIMEOUT");
        expect(result.stderr).toContain("DEPLOY_FORWARD_REPAIR_REQUIRED");
        expect(result.stderr).not.toContain("PACKAGE_STATE_CHANGED_BEFORE_DEPLOY");
        expect(launchctlLog).not.toContain("bootout");
        expect(existsSync(join(harness.state, "tar-ran"))).toBe(true);
        expect(readFileSync(harness.executablePath, "utf8")).toBe(
          "new-generation",
        );
        expect(existsSync(harness.runtime.lockPath)).toBe(false);
      } finally {
        harness.cleanup();
      }
    },
    35_000,
  );

  it(
    "refuses a concurrent remote transaction before staging or replacement",
    () => {
      const harness = makeHarness();
      try {
        mkdirSync(harness.runtime.lockPath);
        writeFileSync(
          join(harness.runtime.lockPath, "holder"),
          `${process.pid}\n`,
        );
        const result = harness.run();
        expect(result.status, result.stderr).toBe(8);
        expect(result.stderr).toContain("DEPLOY_ALREADY_IN_PROGRESS");
        expect(result.stderr).not.toContain("DEPLOY_STALE_LOCK_RECLAIMED");
        expect(existsSync(join(harness.state, "tar-ran"))).toBe(false);
        expect(readFileSync(harness.executablePath, "utf8")).toBe(
          "old-generation",
        );
      } finally {
        harness.cleanup();
      }
    },
    35_000,
  );

  it(
    "reclaims an abandoned lock left by a dropped copy",
    () => {
      const harness = makeHarness();
      try {
        mkdirSync(harness.runtime.lockPath);
        writeFileSync(
          join(harness.runtime.lockPath, "owner"),
          "dead-owner-token\n",
        );
        const result = harness.run();
        expect(result.stderr, result.stderr).toContain(
          "DEPLOY_STALE_LOCK_RECLAIMED",
        );
        expect(result.stderr).not.toContain("DEPLOY_ALREADY_IN_PROGRESS");
        expect(existsSync(join(harness.state, "tar-ran"))).toBe(true);
        expect(existsSync(harness.runtime.lockPath)).toBe(false);
      } finally {
        harness.cleanup();
      }
    },
    35_000,
  );

  it(
    "preserves every preexisting fixed transaction path without inspecting or deleting it",
    () => {
      for (const targetFor of [
        (h: ReturnType<typeof makeHarness>) => `${h.appPath}.incoming`,
        (h: ReturnType<typeof makeHarness>) => `${h.appPath}.previous`,
        (h: ReturnType<typeof makeHarness>) => `${h.appPath}.rejected`,
        (h: ReturnType<typeof makeHarness>) => `${h.plistPath}.incoming`,
        (h: ReturnType<typeof makeHarness>) => `${h.plistPath}.previous`,
        (h: ReturnType<typeof makeHarness>) => `${h.plistPath}.rejected`,
      ]) {
        const harness = makeHarness();
        try {
          const target = targetFor(harness);
          writeFileSync(target, "foreign-transaction-state");
          const result = harness.run();

          expect(result.status).toBe(12);
          expect(result.stderr).toContain("UNBOUND_DEPLOY_PATH_PRESENT");
          expect(readFileSync(target, "utf8")).toBe(
            "foreign-transaction-state",
          );
          expect(existsSync(join(harness.state, "tar-ran"))).toBe(false);
          expect(readFileSync(harness.executablePath, "utf8")).toBe(
            "old-generation",
          );
        } finally {
          harness.cleanup();
        }
      }
    },
    35_000,
  );

  it(
    "preserves an unadmitted existing app and launchd document",
    () => {
      for (const invalid of [
        { FAKE_EXISTING_APP_INVALID: "1" },
        { FAKE_EXISTING_PLIST_INVALID: "1" },
      ]) {
        const harness = makeHarness();
        try {
          const result = harness.run(invalid);
          const launchctlLogPath = join(harness.state, "launchctl.log");
          const launchctlLog = existsSync(launchctlLogPath)
            ? readFileSync(launchctlLogPath, "utf8")
            : "";

          expect(result.status).toBe(12);
          expect(result.stderr).toContain("DEPLOY_NOT_STARTED");
          expect(readFileSync(harness.executablePath, "utf8")).toBe(
            "old-generation",
          );
          expect(readFileSync(harness.plistPath, "utf8")).toBe("old-plist");
          expect(launchctlLog).not.toContain("bootout");
        } finally {
          harness.cleanup();
        }
      }
    },
    35_000,
  );

  it(
    "does not stop an exact incumbent running outside its LaunchAgent",
    () => {
      const harness = makeHarness();
      try {
        rmSync(join(harness.state, "loaded"));
        rmSync(join(harness.state, "pid"));

        const result = harness.run({
          FAKE_UNSUPERVISED_PID: "333",
        });

        expect(result.status, result.stderr).toBe(12);
        expect(result.stderr).toContain(
          "UNSUPERVISED_INCUMBENT_REQUIRES_LAUNCHAGENT exe_pids=333,",
        );
        expect(result.stderr).toContain("DEPLOY_NOT_STARTED");
        expect(readFileSync(harness.executablePath, "utf8")).toBe(
          "old-generation",
        );
        expect(readFileSync(harness.plistPath, "utf8")).toBe("old-plist");
        const launchctlLog = readFileSync(
          join(harness.state, "launchctl.log"),
          "utf8",
        );
        expect(launchctlLog).not.toContain("bootout");
        expect(launchctlLog).not.toContain("kickstart");
        expect(existsSync(`${harness.appPath}.incoming`)).toBe(false);
        expect(existsSync(`${harness.plistPath}.incoming`)).toBe(false);
      } finally {
        harness.cleanup();
      }
    },
    35_000,
  );

  it(
    "refuses to delete a substituted child beneath the admitted app root",
    () => {
      const harness = makeHarness();
      try {
        const result = harness.run({ FAKE_SWAP_APP_CONTENTS: "1" });
        const substitutedMarker = join(
          harness.appPath,
          "Contents",
          "foreign-marker",
        );

        expect(result.status).toBe(13);
        expect(result.stderr).toContain(
          "EXISTING_APP_CONTENTS_CHANGED_BEFORE_RETIREMENT",
        );
        expect(result.stderr).toContain("DEPLOY_FORWARD_REPAIR_REQUIRED");
        expect(readFileSync(substitutedMarker, "utf8")).toBe("foreign");
        expect(
          readFileSync(
            join(
              harness.state,
              "admitted-contents",
              "MacOS",
              "Junto",
            ),
            "utf8",
          ),
        ).toBe("old-generation");
      } finally {
        harness.cleanup();
      }
    },
    35_000,
  );

  it(
    "refuses and preserves a live same-owner control socket",
    async () => {
      const harness = makeHarness();
      const server = createServer();
      mkdirSync(dirname(harness.termSocketPath), { recursive: true });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(harness.termSocketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });

      try {
        const result = harness.run({
          FAKE_LIVE_SOCKET: harness.termSocketPath,
        });
        expect(result.status).toBe(12);
        expect(result.stderr).toContain("CONTROL_SOCKET_STILL_LIVE");
        expect(existsSync(harness.termSocketPath)).toBe(true);
        expect(readFileSync(harness.executablePath, "utf8")).toBe(
          "old-generation",
        );
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        harness.cleanup();
      }
    },
    35_000,
  );

  it(
    "never replaces the app when executable observation is ambiguous",
    () => {
      const harness = makeHarness();
      try {
        const result = harness.run({ FAKE_LSOF_GLOBAL_ERROR: "1" });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("PROCESS_OBSERVATION_FAILED");
        expect(readFileSync(harness.executablePath, "utf8")).toBe(
          "old-generation",
        );
        expect(existsSync(`${harness.appPath}.previous`)).toBe(false);
      } finally {
        harness.cleanup();
      }
    },
    35_000,
  );

  it(
    "retains the candidate and never relaunches the old bundle after readiness failure",
    () => {
      const harness = makeHarness();
      try {
        const result = harness.run();
        expect(result.status).toBe(13);
        expect(result.stderr).toContain("RUNTIME_SOCKET_TIMEOUT");
        expect(result.stderr).toContain("DEPLOY_FORWARD_REPAIR_REQUIRED");
        expect(readFileSync(harness.executablePath, "utf8")).toBe(
          "new-generation",
        );
        expect(readFileSync(harness.plistPath, "utf8")).not.toBe("old-plist");
        expect(existsSync(`${harness.appPath}.previous`)).toBe(false);
        expect(existsSync(`${harness.plistPath}.previous`)).toBe(false);
        expect(existsSync(harness.runtime.lockPath)).toBe(false);
        const launchctlLog = readFileSync(
          join(harness.state, "launchctl.log"),
          "utf8",
        );
        expect(launchctlLog.match(/bootstrap/gu)).toHaveLength(1);
        expect(launchctlLog.match(/bootout/gu)).toHaveLength(1);
        expect(
          readFileSync(
            join(harness.state, "launched-generations.log"),
            "utf8",
          )
            .trim()
            .split("\n"),
        ).toEqual(["old-generation", "new-generation"]);
      } finally {
        harness.cleanup();
      }
    },
    // Headroom above the harness's own 30s spawnSync hang-safety net.
    35_000,
  );

  it(
    "cannot restore or launch the old bundle when candidate kickstart fails",
    () => {
      const harness = makeHarness();
      try {
        const result = harness.run({
          FAKE_CANDIDATE_KICKSTART_FAIL: "1",
        });
        expect(result.status).toBe(13);
        expect(result.stderr).toContain("NEW_LAUNCHD_PID_NOT_PROVEN");
        expect(result.stderr).toContain("DEPLOY_FORWARD_REPAIR_REQUIRED");
        expect(readFileSync(harness.executablePath, "utf8")).toBe(
          "new-generation",
        );
        expect(readFileSync(harness.plistPath, "utf8")).not.toBe("old-plist");
        expect(existsSync(`${harness.appPath}.previous`)).toBe(false);
        expect(existsSync(`${harness.plistPath}.previous`)).toBe(false);
        expect(
          readFileSync(
            join(harness.state, "launched-generations.log"),
            "utf8",
          )
            .trim()
            .split("\n"),
        ).toEqual(["old-generation", "new-generation"]);
        const launchctlLog = readFileSync(
          join(harness.state, "launchctl.log"),
          "utf8",
        );
        expect(launchctlLog.match(/bootstrap/gu)).toHaveLength(1);
        expect(launchctlLog.match(/bootout/gu)).toHaveLength(1);
      } finally {
        harness.cleanup();
      }
    },
    35_000,
  );
});

describe("deploy transfer lifecycle", () => {
  const tarEvents = () => {
    const emitter = new EventEmitter();
    return {
      emitter,
      io: {
        onError: (listener: (error: Error) => void) => {
          emitter.on("error", listener);
          return () => emitter.off("error", listener);
        },
        onClose: (
          listener: (event: {
            readonly code: number | null;
            readonly signal: NodeJS.Signals | null;
          }) => void,
        ) => {
          emitter.on("close", listener);
          return () => emitter.off("close", listener);
        },
      },
    };
  };

  it("records tar exit even when it happens before remote readiness is awaited", async () => {
    const tar = tarEvents();
    const exit = watchTarExit(tar.io);
    tar.emitter.emit("close", { code: 1, signal: null });

    await expect(exit.settlement).resolves.toMatchObject({
      ok: false,
      error: { message: "local tar exited 1" },
    });
    await expect(exit.closed).resolves.toBeUndefined();
    expect(exit.isClosed()).toBe(true);
  });

  it("accepts a close witness replayed during central observer registration", async () => {
    const exit = watchTarExit({
      onError: () => () => undefined,
      onClose: (listener) => {
        listener({ code: 0, signal: null });
        return () => undefined;
      },
    });

    await expect(exit.settlement).resolves.toEqual({ ok: true });
    await expect(exit.closed).resolves.toBeUndefined();
    expect(exit.isClosed()).toBe(true);
  });

  it("does not treat a tar error as a terminal-close witness", async () => {
    const tar = tarEvents();
    const exit = watchTarExit(tar.io);
    let closed = false;
    void exit.closed.then(() => {
      closed = true;
    });
    tar.emitter.emit("error", new Error("spawn failed"));

    await expect(exit.settlement).resolves.toMatchObject({
      ok: false,
      error: { message: "spawn failed" },
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    tar.emitter.emit("close", { code: 1, signal: null });
    await expect(exit.closed).resolves.toBeUndefined();
    expect(tar.emitter.listenerCount("error")).toBe(0);
    expect(tar.emitter.listenerCount("close")).toBe(0);
  });

  it("bounds a never-closing tar wait and clears its timer", async () => {
    const tar = tarEvents();
    const exit = watchTarExit(tar.io);
    const started = Date.now();
    await awaitTarCloseBounded(exit, 10);

    expect(Date.now() - started).toBeLessThan(250);
    expect(exit.isClosed()).toBe(false);
  });

  it("captures bounded tar stderr while draining the stream", () => {
    const stderr = new EventEmitter();
    const captured = captureTarStderr(stderr as never);
    stderr.emit("data", Buffer.alloc(64 * 1024, "a"));
    stderr.emit("data", Buffer.from("discarded"));

    expect(Buffer.byteLength(captured(), "utf8")).toBe(64 * 1024);
  });

  it("surfaces bounded remote readiness diagnostics on a failed transfer", () => {
    const darwin = new SshTransferExitError(
      "remote" as never,
      3,
      "",
      "REMOTE_NOT_DARWIN Linux",
    );
    expect(describeDeployTransferFailure(darwin)).toContain("not macOS");

    const timeout = new SshTransferExitError(
      "remote" as never,
      2,
      "ENROLLMENT_SOCKET_TIMEOUT",
      "ENROLLMENT_PARTIAL pid=9 station=0",
    );
    expect(describeDeployTransferFailure(timeout)).toContain("ENROLLMENT_PARTIAL");

    const noisy = new SshTransferExitError(
      "remote" as never,
      2,
      "",
      "--prepared:/Applications/Junto.app.incoming/Junto.app\nENROLLMENT_SOCKET_TIMEOUT pid=9 station=0\n",
    );
    expect(describeDeployTransferFailure(noisy)).toBe(
      "ENROLLMENT_SOCKET_TIMEOUT pid=9 station=0",
    );
  });

  it("binds activate-script uname through a variable so quoting stays exact", () => {
    const script = buildRemoteRuntimeActivateScript("/Users/developer");
    expect(script).toContain("UNAME='/usr/bin/uname'");
    expect(script).toContain('test "$("$UNAME" -s)" = "Darwin"');
    expect(script).not.toContain(`"$("'/usr/bin/uname'"`);
    expect(script).not.toContain("--vellum-headless");
  });

  it("maps remote transaction exit receipts by cutover phase", () => {
    const failure = (code: number) =>
      new SshTransferExitError("remote" as never, code, "", "failed");

    expect(classifyDeployTransferDisposition(failure(3))).toBe("not-started");
    expect(classifyDeployTransferDisposition(failure(12))).toBe("not-started");
    expect(classifyDeployTransferDisposition(failure(2))).toBe(
      "indeterminate",
    );
    expect(classifyDeployTransferDisposition(failure(4))).toBe(
      "indeterminate",
    );
    expect(classifyDeployTransferDisposition(failure(5))).toBe(
      "indeterminate",
    );
    expect(classifyDeployTransferDisposition(failure(6))).toBe(
      "indeterminate",
    );
    expect(classifyDeployTransferDisposition(failure(7))).toBe(
      "indeterminate",
    );
    expect(classifyDeployTransferDisposition(failure(8))).toBe(
      "indeterminate",
    );
    expect(classifyDeployTransferDisposition(failure(9))).toBe(
      "indeterminate",
    );
    expect(classifyDeployTransferDisposition(failure(13))).toBe(
      "indeterminate",
    );
    expect(classifyDeployTransferDisposition(failure(10))).toBe("ready");
    expect(classifyDeployTransferDisposition(new Error("transport"))).toBe(
      "indeterminate",
    );
  });
});
