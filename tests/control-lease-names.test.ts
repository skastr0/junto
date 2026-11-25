/**
 * Linux control lease names are HMAC-SHA256 under a key only this uid reads,
 * kept under its passwd home, so another local user cannot take a core's
 * name first, and a relinked Junto home keeps the same names (control-
 * filesystem.ts, remote-security's six terms of 25 November). The account
 * home here is a temp directory set through the test-only setter.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireControlListenerLease,
  prepareControlDirectory,
  releaseControlListenerLease,
  setControlLeaseAccountHomeForTests,
  type ControlListenerLease,
} from "../src/node/control-filesystem";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  setControlLeaseAccountHomeForTests(undefined);
  vi.restoreAllMocks();
});
const root = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "junto-lease-names-"));
  cleanups.push(async () => { chmodSync(path, 0o700); await rm(path, { recursive: true, force: true }); });
  return path;
};
/** A usable account home: this uid's, 0700. */
const account = async (): Promise<string> => {
  const home = join(await root(), "account");
  mkdirSync(home, { mode: 0o700 });
  setControlLeaseAccountHomeForTests(home);
  return home;
};
const socketOf = (home: string): string => join(home, ".junto", "operator", "control.sock");
const lease = async (home: string): Promise<ControlListenerLease> => {
  prepareControlDirectory(join(home, ".junto", "operator"));
  const held = await acquireControlListenerLease(socketOf(home));
  cleanups.push(() => releaseControlListenerLease(held));
  return held;
};
/** Bind the name today's builds use for `path`, as a squatter who knows the path can. */
const squat = async (path: string): Promise<void> => {
  const server: Server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(`\0junto-control-${createHash("sha256").update(path).digest("hex")}`, resolve); });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
};

describe.skipIf(process.platform !== "linux")("Linux control lease names", () => {
  it("keeps a 32-byte key, owner-only, in 0700 directories under the account home", async () => {
    const home = await account();
    await lease(join(await root(), "far"));
    const key = join(home, ".local", "state", "junto", "control-lease.key");
    expect(readFileSync(key).length).toBe(32);
    expect(lstatSync(key).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(home, ".local", "state", "junto")).mode & 0o777).toBe(0o700);
  });

  it("cannot be blocked by a squatter on today's sha256 name when the key is usable", async () => {
    await account();
    const far = join(await root(), "far");
    prepareControlDirectory(join(far, ".junto", "operator"));
    await squat(socketOf(far));
    await expect(lease(far)).resolves.toBeDefined();
  });

  it("gives two cores of one uid the same names, so the second is refused", async () => {
    const home = await account();
    const far = join(await root(), "far");
    await lease(far);
    await expect(lease(far)).rejects.toThrow("control listener lease unavailable");
    // A second process reads the same key and derives the same names.
    const child = spawnSync("bun", ["-e", `
      const { acquireControlListenerLease, setControlLeaseAccountHomeForTests } = await import(${JSON.stringify(fileURLToPath(new URL("../src/node/control-filesystem.ts", import.meta.url)))});
      setControlLeaseAccountHomeForTests(${JSON.stringify(home)});
      try { await acquireControlListenerLease(${JSON.stringify(socketOf(far))}); console.log("TAKEN"); }
      catch (error) { console.log("REFUSED " + error.message); }
      process.exit(0);`], { encoding: "utf8", env: { ...process.env, VITEST: "true" }, timeout: 20_000 });
    expect(child.stdout.trim()).toBe("REFUSED control listener lease unavailable: live listener or startup in progress");
  });

  it("still refuses a second core on a home relinked to a fresh directory", async () => {
    await account();
    const base = await root();
    mkdirSync(join(base, "real"));
    symlinkSync(join(base, "real"), join(base, "far"));
    await lease(join(base, "far"));
    rmSync(join(base, "far"), { recursive: true, force: true });
    mkdirSync(join(base, "far"));
    await expect(lease(join(base, "far"))).rejects.toThrow("control listener lease unavailable");
  });

  it("falls back to names from the path when the account home cannot be written, says so once, and still refuses the relink", async () => {
    const home = await account();
    chmodSync(home, 0o500);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const base = await root();
    mkdirSync(join(base, "real"));
    symlinkSync(join(base, "real"), join(base, "far"));
    await lease(join(base, "far"));
    rmSync(join(base, "far"), { recursive: true, force: true });
    mkdirSync(join(base, "far"));
    await expect(lease(join(base, "far"))).rejects.toThrow("control listener lease unavailable");
    await lease(join(base, "other"));
    expect(warn.mock.calls.filter(([line]) => String(line).startsWith("[control] control lease names come from their paths"))).toHaveLength(1);
    // The fallback names are today's: a squatter on one blocks it, as before.
    const squatted = join(base, "squatted");
    prepareControlDirectory(join(squatted, ".junto", "operator"));
    await squat(socketOf(squatted));
    await expect(lease(squatted)).rejects.toThrow("control listener lease unavailable");
  });

  it.each([
    ["a directory above the key others can write", (home: string) => { mkdirSync(join(home, ".local"), { mode: 0o700 }); chmodSync(join(home, ".local"), 0o777); }],
    ["a directory above the key that is a symlink", (home: string) => { mkdirSync(join(home, "elsewhere")); symlinkSync(join(home, "elsewhere"), join(home, ".local")); }],
    ["a key that is not whole", (home: string) => { mkdirSync(join(home, ".local", "state", "junto"), { recursive: true, mode: 0o700 }); writeFileSync(join(home, ".local", "state", "junto", "control-lease.key"), "short", { mode: 0o600 }); }],
    ["a key others can read", (home: string) => { mkdirSync(join(home, ".local", "state", "junto"), { recursive: true, mode: 0o700 }); writeFileSync(join(home, ".local", "state", "junto", "control-lease.key"), Buffer.alloc(32, 1), { mode: 0o644 }); }],
  ] as const)("refuses the start, never falling back, for %s", async (_name, fault) => {
    const home = await account();
    fault(home);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(lease(join(await root(), "far"))).rejects.toMatchObject({ name: "ControlLeaseKeyRefused", message: expect.stringContaining("Junto does not start until it is") });
    expect(warn).not.toHaveBeenCalled();
  });
});
