import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Log } from "../src/node/observability/logger";
import {
  bumpServiceBoots,
  installServiceCrashLog,
  readServiceFileTail,
  recordServiceBoot,
  SERVICE_BOOT_HISTORY,
  serviceCrashExit,
  serviceInstallRoot,
  truncateServiceFile,
} from "../src/node/hosts/service-runtime";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "junto-service-runtime-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("serviceInstallRoot", () => {
  it("derives the install root from the bundled core entry", () => {
    expect(serviceInstallRoot("/h/.junto/machine/current/core/junto.cjs")).toBe("/h/.junto/machine");
    const gen = "a".repeat(64);
    expect(serviceInstallRoot(`/h/.junto/machine/builds/${gen}-darwin-arm64/core/junto.cjs`)).toBe("/h/.junto/machine");
    expect(serviceInstallRoot(`/h/.junto/machine/builds/${gen}-linux-x64/core/junto.cjs`)).toBe("/h/.junto/machine");
  });

  it("refuses every other entry shape", () => {
    expect(serviceInstallRoot("/repo/src/core/headless.ts")).toBeUndefined();
    expect(serviceInstallRoot("/h/.junto/machine/current/core/other.cjs")).toBeUndefined();
    expect(serviceInstallRoot("/h/.junto/machine/builds/nothex-core/core/junto.cjs")).toBeUndefined();
    expect(serviceInstallRoot("/h/.junto/machine/builds/" + "a".repeat(64) + "-win32/core/junto.cjs")).toBeUndefined();
    expect(serviceInstallRoot("/h/current/core/junto.cjs/extra")).toBeUndefined();
  });
});

describe("service file bounds", () => {
  it("reads only the tail of an owned regular file", async () => {
    const file = join(dir, "stderr.log");
    await writeFile(file, "x".repeat(50) + "tail-end", { mode: 0o600 });
    expect((await readServiceFileTail(file, 8))?.toString()).toBe("tail-end");
    expect(await readServiceFileTail(join(dir, "missing.log"), 8)).toBeUndefined();
  });

  it("refuses a linked service file for read and truncate", async () => {
    const real = join(dir, "real.log");
    const link = join(dir, "stderr.log");
    await writeFile(real, "content", { mode: 0o600 });
    await symlink(real, link);
    expect(await readServiceFileTail(link, 8)).toBeUndefined();
    expect(truncateServiceFile(link)).toBe(false);
    expect(await readFile(real, "utf8")).toBe("content");
  });

  it("truncates an owned file and reports absence", async () => {
    const file = join(dir, "stderr.log");
    await writeFile(file, "crash output\n".repeat(100), { mode: 0o600 });
    expect(truncateServiceFile(file)).toBe(true);
    expect((await stat(file)).size).toBe(0);
    expect(truncateServiceFile(join(dir, "missing.log"))).toBe(false);
  });
});

describe("service boot history", () => {
  it("appends epoch times and keeps the last eight", async () => {
    const file = join(dir, "core-boots");
    expect(bumpServiceBoots(file, 1000)).toEqual([1000]);
    expect(bumpServiceBoots(file, 2000)).toEqual([1000, 2000]);
    await writeFile(file, Array.from({ length: 10 }, (_, i) => String(5000 + i)).join("\n") + "\ngarbage\n\n", { mode: 0o600 });
    const boots = bumpServiceBoots(file, 9000);
    expect(boots).toHaveLength(SERVICE_BOOT_HISTORY);
    expect(boots.at(-1)).toBe(9000);
    expect(boots[0]).toBe(5003);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});

describe("recordServiceBoot", () => {
  const fakeLog = () => {
    const rows: { level: string; source: string; message: string; annotations?: Record<string, unknown> }[] = [];
    const log = { writeLog: vi.fn((input: { level: "info" | "warn" | "error"; source: string; message: string; annotations?: Record<string, unknown> }) => {
      rows.push(input);
      return {};
    }) } as unknown as Log;
    return { log, rows };
  };

  it("writes the previous stderr tail, truncates the file, and records the boot", async () => {
    const installRoot = join(dir, "machine");
    await mkdir(join(installRoot, "logs"), { recursive: true });
    await writeFile(join(installRoot, "logs", "stderr.log"), "boot one noise\nprevious crash reason\n", { mode: 0o600 });
    const { log, rows } = fakeLog();
    recordServiceBoot(log, installRoot, Buffer.from("previous crash reason\n"));
    const tail = rows.find(row => row.message.includes("previous service stderr"));
    expect(tail?.level).toBe("warn");
    expect(tail?.message).toContain("previous crash reason");
    expect((await stat(join(installRoot, "logs", "stderr.log"))).size).toBe(0);
    const boot = rows.find(row => row.message === "Junto core boot");
    expect(boot?.annotations?.coreBoots).toBe(1);
    expect(boot?.annotations?.coreBootTimes).toEqual([expect.any(Number)]);
  });

  it("writes only the byte count when the tail row fails", async () => {
    const installRoot = join(dir, "machine2");
    await mkdir(join(installRoot, "logs"), { recursive: true });
    const { log, rows } = fakeLog();
    (log.writeLog as ReturnType<typeof vi.fn>).mockImplementationOnce(() => { throw new Error("sink dead"); });
    recordServiceBoot(log, installRoot, Buffer.from("secret-ish tail"));
    expect(rows.some(row => row.message.includes("secret-ish tail"))).toBe(false);
    expect(rows.some(row => row.message.includes("15 bytes"))).toBe(true);
  });

  it("never throws on a broken install root", async () => {
    const { log } = fakeLog();
    expect(() => recordServiceBoot(log, join(dir, "missing", "root"), Buffer.from("x"))).not.toThrow();
    expect(() => recordServiceBoot(log, dir, undefined)).not.toThrow();
  });
});

describe("service crash exit", () => {
  it("writes the crash row then exits 1", () => {
    const log = { writeLog: vi.fn(() => ({})) } as unknown as Log;
    const exit = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);
    const cause = new Error("boom");
    try {
      expect(() => serviceCrashExit(log, "uncaught exception", cause)).toThrow("exit");
      expect(process.exitCode).toBe(1);
    } finally {
      exit.mockRestore();
      process.exitCode = 0;
    }
    expect(log.writeLog).toHaveBeenCalledWith(expect.objectContaining({
      level: "error", source: "system", message: "Junto core crashed: uncaught exception", failure: cause,
    }));
  });

  it("still exits when the row cannot be written", () => {
    const log = { writeLog: vi.fn(() => { throw new Error("sink dead"); }) } as unknown as Log;
    const exit = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);
    try {
      expect(() => serviceCrashExit(log, "unhandled rejection", "nope")).toThrow("exit");
      expect(process.exitCode).toBe(1);
    } finally {
      exit.mockRestore();
      process.exitCode = 0;
    }
  });

  it("installs and removes both handlers", () => {
    const log = { writeLog: vi.fn(() => ({})) } as unknown as Log;
    const before = process.listenerCount("uncaughtException");
    const off = installServiceCrashLog(log);
    expect(process.listenerCount("uncaughtException")).toBe(before + 1);
    off();
    expect(process.listenerCount("uncaughtException")).toBe(before);
  });
});
