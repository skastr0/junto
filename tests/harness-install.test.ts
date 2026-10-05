import { mkdirSync, writeFileSync, chmodSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  harnessBinaryInstalled,
  resetHostProbedFlagCacheForTests,
  resolveHarnessExecutable,
  supportedHostProbedFlags,
} from "../src/main/junto/term/templates/harness-install";
import { resolveLaunch } from "../src/main/junto/term/local-host";
import { Result } from "effect";

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

const makeScratch = (): string => {
  const dir = join(
    tmpdir(),
    `junto-harness-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  scratchDirs.push(dir);
  return dir;
};

describe("harnessBinaryInstalled", () => {
  it("finds an executable on PATH", () => {
    const dir = makeScratch();
    const bin = join(dir, "fake-claude");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);
    expect(
      harnessBinaryInstalled("claude", "fake-claude", {
        pathEnv: dir,
        home: makeScratch(),
        pathSep: ":",
      }),
    ).toBe(true);
  });

  it("finds the shipped stock Prime Agent binary on PATH", () => {
    const dir = makeScratch();
    const bin = join(dir, "prime-agent");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);
    expect(
      harnessBinaryInstalled("prime-agent", "prime-agent", {
        pathEnv: dir,
        home: makeScratch(),
        pathSep: ":",
      }),
    ).toBe(true);
  });

  it("returns false when binary is absent", () => {
    const empty = makeScratch();
    expect(
      harnessBinaryInstalled("claude", "definitely-missing-cli", {
        pathEnv: empty,
        home: empty,
        pathSep: ":",
      }),
    ).toBe(false);
    expect(
      harnessBinaryInstalled("prime-agent", "prime-agent", {
        pathEnv: empty,
        home: empty,
        pathSep: ":",
      }),
    ).toBe(false);
  });

  it("rejects a non-executable Prime Agent file", () => {
    const dir = makeScratch();
    const bin = join(dir, "prime-agent");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o644);
    expect(
      harnessBinaryInstalled("prime-agent", bin, {
        pathEnv: dir,
        home: makeScratch(),
        pathSep: ":",
      }),
    ).toBe(false);
  });

  it("checks kimi install home outside PATH", () => {
    const home = makeScratch();
    const kimiBinDir = join(home, ".kimi-code", "bin");
    mkdirSync(kimiBinDir, { recursive: true });
    const bin = join(kimiBinDir, "kimi");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);
    expect(
      harnessBinaryInstalled("kimi", "kimi", {
        pathEnv: makeScratch(),
        home,
        pathSep: ":",
      }),
    ).toBe(true);
  });

  it("detects and launches kimi from ~/.kimi-code/bin under a minimal PATH", () => {
    const home = makeScratch();
    const kimiBinDir = join(home, ".kimi-code", "bin");
    mkdirSync(kimiBinDir, { recursive: true });
    const bin = join(kimiBinDir, "kimi");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);
    const minimalPath = "/usr/bin:/bin:/usr/sbin:/sbin";
    const detected = resolveHarnessExecutable("kimi", {
      pathEnv: minimalPath,
      home,
      pathSep: ":",
    });
    expect(detected).toBe(bin);
    expect(
      harnessBinaryInstalled("kimi", "kimi", {
        pathEnv: minimalPath,
        home,
        pathSep: ":",
      }),
    ).toBe(true);

    const workDir = join(home, "work");
    mkdirSync(workDir, { recursive: true });
    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;
    process.env.HOME = home;
    process.env.PATH = minimalPath;
    try {
      const launched = Result.getOrThrow(
        resolveLaunch({
          kind: "agent",
          harness: "kimi",
          agentKey: "local:kimi",
          launch: { kind: "harness", argv: ["kimi"], cwd: workDir },
        }),
      );
      expect(launched.file).toBe(bin);
    } finally {
      process.env.HOME = previousHome;
      process.env.PATH = previousPath;
    }
  });

  it("detects and launches a CLI from an explicit configured tool directory", () => {
    const extra = makeScratch();
    const bin = join(extra, "custom-cli");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);
    const emptyHome = makeScratch();
    const minimalPath = "/usr/bin:/bin";
    expect(
      resolveHarnessExecutable("custom-cli", {
        pathEnv: minimalPath,
        home: emptyHome,
        extraDirs: [extra],
        pathSep: ":",
      }),
    ).toBe(bin);
  });

  it("checks cursor install home outside PATH", () => {
    const home = makeScratch();
    const cursorBinDir = join(home, ".local", "bin");
    mkdirSync(cursorBinDir, { recursive: true });
    const bin = join(cursorBinDir, "agent");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);
    expect(
      harnessBinaryInstalled("cursor", "agent", {
        pathEnv: makeScratch(),
        home,
        pathSep: ":",
      }),
    ).toBe(true);
  });

  it("lets a dead version-manager shim lose to a real binary later in PATH", () => {
    const home = makeScratch();
    const shimsDir = join(home, ".local", "share", "mise", "shims");
    const realDir = join(home, ".local", "share", "mise", "installs", "node", "20", "bin");
    mkdirSync(shimsDir, { recursive: true });
    mkdirSync(realDir, { recursive: true });
    const shim = join(shimsDir, "codex");
    writeFileSync(shim, "#!/bin/sh\necho 'No version is set for shim: codex' >&2\nexit 1\n");
    chmodSync(shim, 0o755);
    const real = join(realDir, "codex");
    writeFileSync(real, "#!/bin/sh\necho '20.0.0'\nexit 0\n");
    chmodSync(real, 0o755);
    const minimalPath = `${shimsDir}:/usr/bin:/bin`;
    expect(
      resolveHarnessExecutable("codex", {
        pathEnv: minimalPath,
        home,
        pathSep: ":",
      }),
    ).toBe(real);
  });

  it("resolves a live shim that answers --version", () => {
    const home = makeScratch();
    const shimsDir = join(home, ".local", "share", "mise", "shims");
    mkdirSync(shimsDir, { recursive: true });
    const shim = join(shimsDir, "codex");
    writeFileSync(shim, "#!/bin/sh\necho '1.0.0'\nexit 0\n");
    chmodSync(shim, 0o755);
    expect(
      resolveHarnessExecutable("codex", {
        pathEnv: "/usr/bin:/bin",
        home,
        pathSep: ":",
      }),
    ).toBe(shim);
  });

  it("refuses an absolute path into a shims dir when the shim is dead", () => {
    const home = makeScratch();
    const shimsDir = join(home, "mise", "shims");
    mkdirSync(shimsDir, { recursive: true });
    const shim = join(shimsDir, "codex");
    writeFileSync(shim, "#!/bin/sh\nexit 1\n");
    chmodSync(shim, 0o755);
    expect(
      resolveHarnessExecutable(shim, { home, pathSep: ":" }),
    ).toBeUndefined();
  });

  it("reports not installed when only a dead shim exists", () => {
    const home = makeScratch();
    const shimsDir = join(home, ".local", "share", "mise", "shims");
    mkdirSync(shimsDir, { recursive: true });
    const shim = join(shimsDir, "codex");
    writeFileSync(shim, "#!/bin/sh\nexit 1\n");
    chmodSync(shim, 0o755);
    expect(
      harnessBinaryInstalled("codex", "codex", {
        pathEnv: "/usr/bin:/bin",
        home,
        pathSep: ":",
      }),
    ).toBe(false);
  });
});

/** A fake harness whose `--help` prints `help` and exits with `status`. */
const fakeHarness = (name: string, help: string, status = 0): string => {
  const bin = join(makeScratch(), name);
  writeFileSync(
    bin,
    `#!/bin/sh\nif [ "$1" = "--help" ]; then\ncat <<'HELP'\n${help}\nHELP\nexit ${status}\nfi\nexit 0\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
};

const CODEX_HELP_WITH_FLAG = [
  "Usage: codex [OPTIONS] [PROMPT]",
  "      --remote <ADDR>",
  "          Connect the TUI to a remote app server endpoint.",
  "      --no-daemon",
  "          Run without the shared background server, even if it is already running",
].join("\n");

const CODEX_HELP_WITHOUT_FLAG = [
  "Usage: codex [OPTIONS] [PROMPT]",
  "  agents   Browse all agent sessions on the shared local app-server daemon",
  "      --no-daemonize-tests",
].join("\n");

describe("supportedHostProbedFlags", () => {
  afterEach(() => resetHostProbedFlagCacheForTests());

  it("returns a flag the installed binary's --help lists", () => {
    const bin = fakeHarness("codex", CODEX_HELP_WITH_FLAG);
    expect(supportedHostProbedFlags(bin, ["--no-daemon"])).toEqual(["--no-daemon"]);
  });

  it("returns nothing for a binary that predates the flag", () => {
    // Mentions "daemon", and a longer flag sharing the prefix: neither counts.
    const bin = fakeHarness("codex", CODEX_HELP_WITHOUT_FLAG);
    expect(supportedHostProbedFlags(bin, ["--no-daemon"])).toEqual([]);
  });

  it("fails soft: a --help that errors yields no flags", () => {
    const bin = fakeHarness("codex", CODEX_HELP_WITH_FLAG, 2);
    expect(supportedHostProbedFlags(bin, ["--no-daemon"])).toEqual([]);
    expect(supportedHostProbedFlags("/nonexistent/codex", ["--no-daemon"])).toEqual([]);
  });

  it("probes again after the binary is upgraded in place", () => {
    const bin = fakeHarness("codex", CODEX_HELP_WITHOUT_FLAG);
    expect(supportedHostProbedFlags(bin, ["--no-daemon"])).toEqual([]);
    writeFileSync(
      bin,
      `#!/bin/sh\ncat <<'HELP'\n${CODEX_HELP_WITH_FLAG}\nHELP\n`,
    );
    chmodSync(bin, 0o755);
    const later = new Date(Date.now() + 60_000);
    utimesSync(bin, later, later);
    expect(supportedHostProbedFlags(bin, ["--no-daemon"])).toEqual(["--no-daemon"]);
  });
});

describe("resolveLaunch host-probed flags", () => {
  afterEach(() => resetHostProbedFlagCacheForTests());

  const codexSeat = (argv: string[]) => ({
    kind: "agent" as const,
    harness: "codex" as const,
    agentKey: "local:codex",
    launch: { kind: "harness" as const, argv, cwd: "/tmp" },
  });

  it("keeps a Codex seat in the launched process when the install supports it", () => {
    const bin = fakeHarness("codex", CODEX_HELP_WITH_FLAG);
    const fresh = Result.getOrThrow(resolveLaunch(codexSeat([bin, "-m", "gpt-x"])));
    expect(fresh.args).toEqual(["--no-daemon", "-m", "gpt-x"]);
    // The flag is global: it goes before the resume subcommand.
    const resumed = Result.getOrThrow(resolveLaunch(codexSeat([bin, "resume", "abc", "-m", "gpt-x"])));
    expect(resumed.args).toEqual(["--no-daemon", "resume", "abc", "-m", "gpt-x"]);
  });

  it("never passes the flag to a Codex that would reject it", () => {
    const bin = fakeHarness("codex", CODEX_HELP_WITHOUT_FLAG);
    const launch = Result.getOrThrow(resolveLaunch(codexSeat([bin, "resume", "abc"])));
    expect(launch.args).toEqual(["resume", "abc"]);
  });

  it("does not repeat a flag the launch already carries", () => {
    const bin = fakeHarness("codex", CODEX_HELP_WITH_FLAG);
    const launch = Result.getOrThrow(resolveLaunch(codexSeat([bin, "--no-daemon"])));
    expect(launch.args).toEqual(["--no-daemon"]);
  });

  it("leaves harnesses without host-probed flags untouched", () => {
    const bin = fakeHarness("claude", CODEX_HELP_WITH_FLAG);
    const launch = Result.getOrThrow(
      resolveLaunch({
        kind: "agent",
        harness: "claude",
        agentKey: "local:claude",
        launch: { kind: "harness", argv: [bin, "--permission-mode", "default"], cwd: "/tmp" },
      }),
    );
    expect(launch.args).toEqual(["--permission-mode", "default"]);
  });
});
