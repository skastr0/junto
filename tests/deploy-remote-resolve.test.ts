import { EventEmitter } from "node:events";
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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  buildRemoteDeployScript,
  buildRemoteDeployScriptForTest,
  classifyDeployTransferDisposition,
  describeDeployTransferFailure,
  decodeRemoteHomeDirectoryOutput,
  captureTarStderr,
  awaitTarCloseBounded,
  isSafeRemoteHomePath,
  parseDeployTransferResult,
  resolveLocalAppBundle,
  validateLocalBundleProvenance,
  type RemoteDeployScriptTestRuntime,
  watchTarExit,
} from "../src/main/vellum/hosts/deploy-darwin";
import { deployRemoteHost } from "../src/main/vellum/hosts/deploy-remote";
import { SshTransferExitError } from "../src/main/vellum/ssh/service";

const TEST_CDHASH = "0123456789abcdef0123456789abcdef01234567";

describe("resolveLocalAppBundle", () => {
  it("returns a string path or null without throwing", () => {
    // In CI / bare checkout there may be no .app; function must stay pure-safe.
    const path = resolveLocalAppBundle();
    expect(path === null || (typeof path === "string" && path.length > 0)).toBe(
      true,
    );
  });

  it("classifies every local preflight refusal as not started", async () => {
    const result = await Effect.runPromise(
      deployRemoteHost({} as never, {
        id: "local",
        label: "Local",
        kind: "local",
        capabilities: [],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.disposition).toBe("not-started");
  });
});

describe("validateLocalBundleProvenance", () => {
  const appPath = "/release/Vellum Command.app";
  const executablePath = `${appPath}/Contents/MacOS/Vellum Command`;
  const metadata = [
    `Executable=${executablePath}`,
    "Identifier=skastr0.vellum",
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
    bundleIdentifier: "skastr0.vellum",
    bundleExecutable: "Vellum Command",
    bundleVersion: "0.1.0",
    codesignMetadata: metadata,
    ...overrides,
  });

  it("admits only the pinned bundle, executable, team, and Developer ID receipt", () => {
    expect(validateLocalBundleProvenance(valid())).toEqual({
      appPath,
      bundleIdentifier: "skastr0.vellum",
      bundleExecutable: "Vellum Command",
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
      { codesignMetadata: metadata.replace("Identifier=skastr0.vellum", "Identifier=evil") },
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
  it("recognizes only full readiness with both fresh control sockets", () => {
    expect(
      parseDeployTransferResult({
        stdout: "STATION_READY pid=4312 term=1 browser=1",
        stderr: "",
      }),
    ).toMatchObject({
      ok: true,
      detail: expect.stringContaining("term + browser"),
    });
  });

  it("refuses legacy, invalid-pid, and absent generation markers", () => {
    for (const stdout of [
      "STATION_READY term=1 browser=1",
      "STATION_READY pid=0 term=1 browser=1",
      "TERM_SOCK_OK browser=0",
      "TERM_SOCK_OK pid=4313 browser=0",
      "TERM_SOCK_OK pid=-1 browser=0",
      "",
    ]) {
      expect(
        parseDeployTransferResult({
          stdout,
          stderr: "STATION_PARTIAL term=0 browser=0",
        }),
      ).toMatchObject({
        ok: false,
        detail: expect.stringContaining("did not prove"),
      });
    }
  });
});

describe("buildRemoteDeployScript", () => {
  const script = buildRemoteDeployScript(
    "/Users/remote station",
    TEST_CDHASH,
  );

  it("keeps every destructive remote target fixed to Vellum paths", () => {
    expect(script).toContain("APP='/Applications/Vellum Command.app'");
    expect(script).toContain("IN='/Applications/Vellum Command.app.incoming'");
    expect(script).toContain(
      "TERM_SOCK='/Users/remote station/.vellum/term/control.sock'",
    );
    expect(script).toContain(
      "BROWSER_SOCK='/Users/remote station/.vellum/browser/control.sock'",
    );

    const recursiveRemovals = script
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("/bin/rm -rf"));
    expect(recursiveRemovals).toEqual([
      '/bin/rm -rf -- "$APP" || return 1',
      '/bin/rm -rf -- "$APP" || return 1',
      '/bin/rm -rf -- "$IN" >/dev/null 2>&1 || true',
      '/bin/rm -rf -- "$APP_PREVIOUS" >/dev/null 2>&1 || echo "APP_BACKUP_CLEANUP_FAILED $APP_PREVIOUS" >&2',
      '/bin/rm -rf -- "$IN"',
      '/bin/rm -rf -- "$IN"',
    ]);
    expect(script).toContain('"$TAR" -C "$IN/$BUNDLE" -xf -');
    expect(script).toContain(
      "DEPLOY_LOCK='/Applications/.vellum-command-deploy.lock'",
    );
    expect(script).toContain(`EXPECTED_CDHASH='${TEST_CDHASH}'`);
    expect(script).toContain("anchor apple generic");
    expect(script).toContain("certificate leaf[subject.OU]");
    expect(script).toContain(
      '"$CODESIGN" --verify --deep --strict --verbose=2 -R "$DEVELOPER_ID_REQUIREMENT"',
    );
  });

  it("proves the old job and exact executable gone before replacement", () => {
    const validation = script.indexOf(
      '"$CODESIGN" --verify --deep --strict',
    );
    const quit = script.indexOf('"$OSASCRIPT" -e');
    const bootout = script.indexOf('"$LAUNCHCTL" bootout "$JOB"', quit);
    const boundedProof = script.indexOf(
      "if ! wait_until_job_and_executable_gone 30; then",
      bootout,
    );
    const proofFailure = script.indexOf(
      "OLD_GENERATION_STILL_PRESENT",
      boundedProof,
    );
    const socketRemoval = script.indexOf(
      'remove_fixed_socket "$TERM_SOCK"',
      proofFailure,
    );
    const appTransition = script.indexOf(
      '/bin/mv "$APP" "$APP_PREVIOUS"',
      socketRemoval,
    );

    expect(validation).toBeGreaterThan(0);
    expect(quit).toBeGreaterThan(validation);
    expect(quit).toBeGreaterThan(0);
    expect(bootout).toBeGreaterThan(quit);
    expect(script).toContain("with timeout of 5 seconds");
    expect(boundedProof).toBeGreaterThan(bootout);
    expect(proofFailure).toBeGreaterThan(boundedProof);
    expect(socketRemoval).toBeGreaterThan(proofFailure);
    expect(appTransition).toBeGreaterThan(socketRemoval);
    expect(script).toContain(
      'if ! OBSERVED_EXE_PIDS="$(exact_exe_pids)"; then',
    );
    expect(script).toContain('ALL_LSOF_OUTPUT="$("$LSOF" -n -d txt');
    expect(script).not.toMatch(/\b(?:kill|pkill|killall)\b/u);
  });

  it("uses launchd exclusively and requires a distinct executable-backed generation", () => {
    expect(script).toContain('"$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST"');
    expect(script).toContain('"$LAUNCHCTL" kickstart -p "$JOB"');
    expect(script).toContain(
      'if [ -n "$OLD_PID" ] && [ "$NEW_PID" = "$OLD_PID" ]; then',
    );
    expect(script).toContain('exact_exe_has_pid "$NEW_PID"');
    expect(script).not.toContain("/usr/bin/open");
    expect(script).not.toMatch(/"\$EXE"[^\n]*&/u);
  });

  it("cannot accept preexisting or wrong-owner control sockets as ready", () => {
    const termRemoval = script.lastIndexOf('remove_fixed_socket "$TERM_SOCK"');
    const browserRemoval = script.lastIndexOf(
      'remove_fixed_socket "$BROWSER_SOCK"',
    );
    const bootstrap = script.lastIndexOf(
      'if ! "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST"',
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
    expect(termWitness).toBeGreaterThan(bootstrap);
    expect(browserWitness).toBeGreaterThan(termWitness);
    expect(script).toContain(
      '"$LSOF" -n -a -U -Fp -- "$1"',
    );
    expect(script).not.toContain('if [ -S "$TERM_SOCK" ]');
    expect(script).not.toContain('if [ -S "$BROWSER_SOCK" ]');
    expect(script).toContain(
      'if job_exists && exact_exe_has_pid "$NEW_PID"',
    );
    expect(script).toContain("rollback_deploy() {");
  });

  it("quotes shell-active home characters and rejects non-canonical homes", () => {
    const shellActive = buildRemoteDeployScript(
      "/Users/remote$(touch should-not-run)",
      TEST_CDHASH,
    );
    expect(shellActive).toContain(
      "TERM_SOCK='/Users/remote$(touch should-not-run)/.vellum/term/control.sock'",
    );
    const apostrophe = buildRemoteDeployScript(
      "/Users/o'malley",
      TEST_CDHASH,
    );
    expect(apostrophe).toContain(
      `TERM_SOCK='/Users/o'"'"'malley/.vellum/term/control.sock'`,
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
      expect(() => buildRemoteDeployScript(home, TEST_CDHASH)).toThrow(
        "canonical absolute path",
      );
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
  const makeHarness = () => {
    const root = mkdtempSync(join(tmpdir(), "vellum-deploy-test-"));
    const bin = join(root, "bin");
    const state = join(root, "state");
    const remoteHome = join(root, "Users", "remote");
    const appPath = join(root, "Applications", "Vellum Command.app");
    const executablePath = join(
      appPath,
      "Contents",
      "MacOS",
      "Vellum Command",
    );
    const plistPath = join(
      remoteHome,
      "Library",
      "LaunchAgents",
      "skastr0.vellum.plist",
    );
    mkdirSync(bin, { recursive: true });
    mkdirSync(state, { recursive: true });
    mkdirSync(join(appPath, "Contents", "MacOS"), { recursive: true });
    mkdirSync(join(appPath, "Contents", "Resources"), { recursive: true });
    mkdirSync(join(remoteHome, "Library", "LaunchAgents"), {
      recursive: true,
    });
    writeFileSync(executablePath, "old-generation", { mode: 0o755 });
    writeFileSync(join(appPath, "Contents", "Info.plist"), "old-info");
    writeFileSync(plistPath, "old-plist");
    writeFileSync(join(state, "loaded"), "1");
    writeFileSync(join(state, "pid"), "100\n");

    const executable = (name: string, body: string): string => {
      const path = join(bin, name);
      writeFileSync(path, `#!/bin/bash\nset -euo pipefail\n${body}\n`);
      chmodSync(path, 0o755);
      return path;
    };
    const commands = {
      uname: executable("uname", 'echo "Darwin"'),
      id: executable("id", 'echo "501"'),
      launchctl: executable(
        "launchctl",
        [
          'echo "$1" >> "$FAKE_STATE/launchctl.log"',
          'case "$1" in',
          '  print) test -f "$FAKE_STATE/loaded" ;;',
          '  kickstart) test -f "$FAKE_STATE/loaded"; cat "$FAKE_STATE/pid" ;;',
          "  bootout)",
          '    bootouts="$(cat "$FAKE_STATE/bootout-count" 2>/dev/null || echo 0)"',
          '    bootouts="$((bootouts + 1))"',
          '    printf \'%s\\n\' "$bootouts" > "$FAKE_STATE/bootout-count"',
          '    if [ "$FAKE_SIGNAL_DURING_ROLLBACK" = "1" ] && [ "$bootouts" -ge 2 ]; then kill -TERM "$PPID"; sleep 0.2; fi',
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
          'for arg in "$@"; do if [ "$arg" = "-p" ]; then is_pid=1; fi; done',
          'if [ "$is_pid" = "0" ] && [ "$FAKE_LSOF_GLOBAL_ERROR" = "1" ]; then',
          '  echo "observer failed" >&2',
          "  exit 1",
          "fi",
          'test -f "$FAKE_STATE/loaded" || exit 0',
          'pid="$(cat "$FAKE_STATE/pid")"',
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
          'mkdir -p "$target/Contents/MacOS" "$target/Contents/Resources"',
          "printf 'new-generation' > \"$target/Contents/MacOS/Vellum Command\"",
          'chmod 755 "$target/Contents/MacOS/Vellum Command"',
          "printf 'new-info' > \"$target/Contents/Info.plist\"",
          'touch "$FAKE_STATE/tar-ran"',
        ].join("\n"),
      ),
      codesign: executable(
        "codesign",
        [
          'if [ "$FAKE_CODESIGN_FAIL" = "1" ]; then exit 1; fi',
          'if [ "$1" = "-d" ]; then',
          '  target="${@: -1}"',
          '  echo "Executable=$target/Contents/MacOS/Vellum Command" >&2',
          '  echo "Identifier=skastr0.vellum" >&2',
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
      plutil: executable(
        "plutil",
        [
          'case "$*" in',
          '  *CFBundleIdentifier*) echo "skastr0.vellum" ;;',
          '  *CFBundleExecutable*) echo "Vellum Command" ;;',
          "  *) exit 1 ;;",
          "esac",
        ].join("\n"),
      ),
      osascript: executable("osascript", "exit 0"),
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
    );
    const run = (overrides: NodeJS.ProcessEnv = {}) =>
      spawnSync("/bin/bash", ["-lc", script], {
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          FAKE_STATE: state,
          FAKE_EXE: executablePath,
          FAKE_CODESIGN_FAIL: "0",
          FAKE_REMOTE_CDHASH: TEST_CDHASH,
          FAKE_LSOF_GLOBAL_ERROR: "0",
          FAKE_SIGNAL_DURING_ROLLBACK: "0",
          ...overrides,
        },
      });
    return {
      root,
      state,
      appPath,
      executablePath,
      plistPath,
      runtime,
      run,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  };

  it("validates the transferred signature before stopping the old job", () => {
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
  });

  it("binds the transferred generation to the locally admitted code hash", () => {
    const harness = makeHarness();
    try {
      const result = harness.run({
        FAKE_REMOTE_CDHASH: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      });
      const launchctlLogPath = join(harness.state, "launchctl.log");
      const launchctlLog = existsSync(launchctlLogPath)
        ? readFileSync(launchctlLogPath, "utf8")
        : "";
      expect(result.status).toBe(3);
      expect(result.stderr).toContain("REMOTE_SIGNATURE_GENERATION_MISMATCH");
      expect(launchctlLog).not.toContain("bootout");
      expect(readFileSync(harness.executablePath, "utf8")).toBe(
        "old-generation",
      );
      expect(existsSync(join(harness.state, "loaded"))).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  it("refuses a concurrent remote transaction before staging or replacement", () => {
    const harness = makeHarness();
    try {
      mkdirSync(harness.runtime.lockPath);
      const result = harness.run();
      expect(result.status).toBe(8);
      expect(result.stderr).toContain("DEPLOY_ALREADY_IN_PROGRESS");
      expect(existsSync(join(harness.state, "tar-ran"))).toBe(false);
      expect(readFileSync(harness.executablePath, "utf8")).toBe(
        "old-generation",
      );
    } finally {
      harness.cleanup();
    }
  });

  it("never replaces the app when executable observation is ambiguous", () => {
    const harness = makeHarness();
    try {
      const result = harness.run({ FAKE_LSOF_GLOBAL_ERROR: "1" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(
        /PROCESS_OBSERVATION_FAILED|ROLLBACK_REFUSED_LIVE_GENERATION/u,
      );
      expect(readFileSync(harness.executablePath, "utf8")).toBe(
        "old-generation",
      );
      expect(existsSync(`${harness.appPath}.previous`)).toBe(false);
    } finally {
      harness.cleanup();
    }
  });

  it(
    "restores and restarts the old bundle despite a second termination signal",
    () => {
      const harness = makeHarness();
      try {
        const result = harness.run({ FAKE_SIGNAL_DURING_ROLLBACK: "1" });
        expect(result.status).toBe(2);
        expect(result.stderr).toContain("CONTROL_SOCKET_TIMEOUT");
        expect(readFileSync(harness.executablePath, "utf8")).toBe(
          "old-generation",
        );
        expect(readFileSync(harness.plistPath, "utf8")).toBe("old-plist");
        expect(existsSync(`${harness.appPath}.previous`)).toBe(false);
        expect(existsSync(`${harness.plistPath}.previous`)).toBe(false);
        expect(existsSync(harness.runtime.lockPath)).toBe(false);
        const launchctlLog = readFileSync(
          join(harness.state, "launchctl.log"),
          "utf8",
        );
        expect(launchctlLog.match(/bootstrap/gu)).toHaveLength(2);
        expect(launchctlLog).toMatch(
          /bootout[\s\S]*bootstrap[\s\S]*bootout[\s\S]*bootstrap/u,
        );
      } finally {
        harness.cleanup();
      }
    },
    15_000,
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
      "TERM_SOCK_TIMEOUT",
      "STATION_PARTIAL term=0 browser=0",
    );
    expect(describeDeployTransferFailure(timeout)).toContain("STATION_PARTIAL");
  });

  it("maps remote transaction exit receipts without overstating rollback", () => {
    const failure = (code: number) =>
      new SshTransferExitError("remote" as never, code, "", "failed");

    expect(classifyDeployTransferDisposition(failure(8))).toBe(
      "indeterminate",
    );
    expect(classifyDeployTransferDisposition(failure(9))).toBe(
      "indeterminate",
    );
    expect(classifyDeployTransferDisposition(failure(10))).toBe("ready");
    expect(classifyDeployTransferDisposition(failure(7))).toBe("rolled-back");
    expect(classifyDeployTransferDisposition(new Error("transport"))).toBe(
      "indeterminate",
    );
  });
});
