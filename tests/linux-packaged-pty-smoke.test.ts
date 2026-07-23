import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TerminalLaunch } from "../src/shared/terminal";
import type { LocalHostEvent } from "../src/main/vellum/term/local-host";
import {
  auditLinuxPtyPlacement,
  exerciseLinuxPackagedPty,
  LINUX_PTY_PROBE_COMMAND,
  verifyLinuxPtyProbe,
  type LinuxPtySmokeControl,
} from "../scripts/linux-packaged-pty-smoke";

const roots: string[] = [];
const root = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "vellum-linux-pty-layout-"));
  roots.push(path);
  return path;
};
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("Linux packaged PTY layout audit", () => {
  it("requires an unpacked native module and executable spawn helper", async () => {
    const resources = await root();
    const base = join(resources, "app.asar.unpacked", "node_modules", "node-pty", "prebuilds", "linux-x64");
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "pty.node"), "native");
    writeFileSync(join(base, "spawn-helper"), "helper");
    chmodSync(join(base, "spawn-helper"), 0o755);

    expect(auditLinuxPtyPlacement(resources)).toMatchObject({
      nativeModule: join(base, "pty.node"),
      spawnHelper: join(base, "spawn-helper"),
    });
  });

  it("rejects ASAR-only or non-executable helpers", async () => {
    const resources = await root();
    const base = join(resources, "app.asar.unpacked", "node_modules", "node-pty", "prebuilds", "linux-x64");
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "pty.node"), "native");
    writeFileSync(join(base, "spawn-helper"), "helper");
    chmodSync(join(base, "spawn-helper"), 0o644);
    expect(() => auditLinuxPtyPlacement(resources)).toThrow(/spawn-helper/u);
  });
});

class FakePtyControl implements LinuxPtySmokeControl {
  readonly listeners = new Set<(event: LocalHostEvent) => void>();
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  launch: TerminalLaunch | undefined;
  backend: "pty" | undefined = "pty";
  output = [
    "PTY-ECHO:ok",
    "UTF8:✓",
    "TERM:xterm-256color",
    "COLORTERM:truecolor",
    "SIZE:101 41",
    "LOGIN:yes",
  ].join("\r\n");

  create: LinuxPtySmokeControl["create"] = async (input) => {
    this.launch = input.launch;
    return {
      bindingId: input.bindingId,
      epoch: "epoch-1",
      hostId: "local",
      status: "running",
      cwd: "/tmp",
      detached: true,
      createdAt: 1,
      backend: this.backend,
    };
  };

  attach: LinuxPtySmokeControl["attach"] = async () => ({
    ok: true,
    lease: {
      leaseId: "lease-1",
      bindingId: "linux-packaged-pty-smoke",
      epoch: "epoch-1",
      mode: "control",
    },
    cols: 80,
    rows: 24,
    journal: [],
    status: "running",
  });

  write: LinuxPtySmokeControl["write"] = async (_leaseId, data) => {
    this.writes.push(data);
    if (data === LINUX_PTY_PROBE_COMMAND) {
      queueMicrotask(() => {
        this.emit({
          type: "output",
          bindingId: "linux-packaged-pty-smoke",
          epoch: "epoch-1",
          seq: 1n,
          data: `${this.output}\r\n`,
        });
        this.emit({
          type: "exit",
          bindingId: "linux-packaged-pty-smoke",
          epoch: "epoch-1",
          seq: 2n,
          code: 23,
          // Real node-pty uses signal=0 for an ordinary exit.
          signal: 0,
        });
      });
    }
    return true;
  };

  resize: LinuxPtySmokeControl["resize"] = async (_leaseId, cols, rows) => {
    this.resizes.push({ cols, rows });
    return true;
  };

  release: LinuxPtySmokeControl["release"] = async () => undefined;
  kill: LinuxPtySmokeControl["kill"] = async () => true;

  on(_event: "event", listener: (event: LocalHostEvent) => void): void {
    this.listeners.add(listener);
  }

  off(_event: "event", listener: (event: LocalHostEvent) => void): void {
    this.listeners.delete(listener);
  }

  private emit(event: LocalHostEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

describe("Linux packaged PTY product-path smoke", () => {
  it("drives Bash login mode, UTF-8, resize, environment, and exit over term control", async () => {
    const control = new FakePtyControl();

    await expect(exerciseLinuxPackagedPty(control, {
      settleEchoDisabled: () => Promise.resolve(),
    })).resolves.toEqual({
      backend: "pty",
      interactiveEcho: true,
      utf8: true,
      resized: { cols: 101, rows: 41 },
      term: "xterm-256color",
      colorterm: "truecolor",
      loginShell: true,
      exitCode: 23,
    });

    expect(control.launch).toEqual({ kind: "shell", argv: ["/bin/bash", "-l"] });
    expect(control.resizes).toEqual([{ cols: 101, rows: 41 }]);
    expect(control.writes).toEqual(["stty -echo\r", LINUX_PTY_PROBE_COMMAND]);
    expect(LINUX_PTY_PROBE_COMMAND).toContain("shopt -q login_shell");
    expect(LINUX_PTY_PROBE_COMMAND).not.toContain("case \"$-\"");
  });

  it("requires complete output lines so echoed command text cannot fake proof", () => {
    expect(() => verifyLinuxPtyProbe({
      output: `bash$ ${LINUX_PTY_PROBE_COMMAND}`,
      exitCode: 23,
      signal: undefined,
    })).toThrow(/missing/u);
  });

  it("rejects a non-login Bash shell", () => {
    expect(() => verifyLinuxPtyProbe({
      output: [
        "PTY-ECHO:ok",
        "UTF8:✓",
        "TERM:xterm-256color",
        "COLORTERM:truecolor",
        "SIZE:101 41",
        "LOGIN:no",
      ].join("\n"),
      exitCode: 23,
      signal: undefined,
    })).toThrow(/LOGIN:yes/u);
  });

  it("launches the packaged app path instead of a disabled Electron Node mode", () => {
    const source = readFileSync(
      new URL("../scripts/linux-packaged-pty-smoke.ts", import.meta.url),
      "utf8",
    );
    const unsupportedSwitch = `--${["run", "AsNode"].join("")}`;

    expect(source).not.toContain(unsupportedSwitch);
    expect(source).toContain("TermControlClient.connect");
    expect(source).toContain("createAppProcessPlane()");
    expect(source).toContain("--vellum-headless");
    expect(source).not.toContain("process.exit(1)");
    expect(source).toContain("process.exitCode = 1");
  });
});
