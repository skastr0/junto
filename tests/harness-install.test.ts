import { mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  harnessBinaryInstalled,
  resolveHarnessExecutable,
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
