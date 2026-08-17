import { mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { harnessBinaryInstalled } from "../src/main/vellum/term/templates/harness-install";

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
    `vellum-harness-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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
});
