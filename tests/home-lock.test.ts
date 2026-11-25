/**
 * The home database lock (src/node/home-lock.ts): one core, or one install's
 * restore, on a home's state at a time, refused at once rather than waited
 * on, released by the kernel with its holder and never inherited by a child.
 * Terms from remote-security's read, 25 November.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, linkSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { acquireHomeLock, HOME_LOCK_FILE, type HomeLock } from "../src/node/home-lock";

const child = fileURLToPath(new URL("./fixtures/home-lock-child.ts", import.meta.url));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const home = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "junto-home-lock-"));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
};
const take = async (at: string): Promise<HomeLock> => {
  const lock = await acquireHomeLock(at);
  cleanups.push(() => lock.release());
  return lock;
};
const stateOf = (at: string): string => join(at, ".junto", "state");

/** A core's lock in its own process; answers its first line. */
const run = (mode: "hold" | "orphan", at: string): { process: ChildProcess; line: Promise<string> } => {
  const holder = spawn("bun", [child, mode, at], { stdio: ["ignore", "pipe", "inherit"] });
  cleanups.push(() => { holder.kill("SIGKILL"); });
  const line = new Promise<string>((resolve, reject) => {
    let out = "";
    holder.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.includes("\n")) resolve(out.split("\n")[0]!);
    });
    holder.once("exit", () => resolve(out.split("\n")[0] ?? ""));
    holder.once("error", reject);
  });
  return { process: holder, line };
};

describe("the home lock", () => {
  it("lets exactly one of two cores that start at once run", async () => {
    const at = await home();
    const lines = (await Promise.all([run("hold", at).line, run("hold", at).line])).sort();
    expect(lines).toEqual(["REFUSED held", "TAKEN"]);
  });

  it("refuses a second holder in this process, and takes it again once released", async () => {
    const at = await home();
    const lock = await take(at);
    await expect(acquireHomeLock(at)).rejects.toMatchObject({ name: "HomeLockRefused", reason: "held", message: `Another Junto core or an install is using ${at}` });
    await lock.release();
    expect(lock.held()).toBe(false);
    expect((await take(at)).held()).toBe(true);
  });

  it("is free once its holder dies, though a seat the holder started still runs", async () => {
    const at = await home();
    const orphan = run("orphan", at);
    const seat = Number(/^SEAT (\d+)$/u.exec(await orphan.line)?.[1]);
    cleanups.push(() => { try { process.kill(seat, "SIGKILL"); } catch { /* gone */ } });
    await new Promise((resolve) => orphan.process.once("exit", resolve));
    expect(() => process.kill(seat, 0)).not.toThrow();
    expect((await take(at)).held()).toBe(true);
  });

  it("refuses a state directory that is a symlink or that others can write", async () => {
    const symlinked = await home();
    mkdirSync(join(symlinked, "elsewhere"));
    mkdirSync(join(symlinked, ".junto"));
    symlinkSync(join(symlinked, "elsewhere"), stateOf(symlinked));
    await expect(acquireHomeLock(symlinked)).rejects.toMatchObject({ reason: "unsafe" });
    const open = await home();
    mkdirSync(stateOf(open), { recursive: true });
    chmodSync(stateOf(open), 0o777);
    await expect(acquireHomeLock(open)).rejects.toMatchObject({ reason: "unsafe" });
  });

  it("refuses a lock file another link names, or that others can read", async () => {
    const linked = await home();
    await (await take(linked)).release();
    linkSync(join(stateOf(linked), HOME_LOCK_FILE), join(linked, "second-name"));
    await expect(acquireHomeLock(linked)).rejects.toMatchObject({ reason: "unsafe" });
    const readable = await home();
    await (await take(readable)).release();
    chmodSync(join(stateOf(readable), HOME_LOCK_FILE), 0o644);
    await expect(acquireHomeLock(readable)).rejects.toMatchObject({ reason: "unsafe" });
  });
});

describe.skipIf(process.platform !== "linux")("the home lock on Linux", () => {
  it("keeps a 32-byte id, created once, owner-only, and reached by every path to the directory", async () => {
    const at = await home();
    const lock = await take(at);
    const path = join(stateOf(at), HOME_LOCK_FILE);
    const id = readFileSync(path);
    expect(id.length).toBe(32);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    const link = `${at}-link`;
    symlinkSync(at, link);
    cleanups.push(() => rm(link, { force: true }));
    await expect(acquireHomeLock(link)).rejects.toMatchObject({ reason: "held" });
    await lock.release();
    await (await take(link)).release();
    expect(readFileSync(path).equals(id)).toBe(true);
  });

  it("cannot be blocked by a squatter on a name guessed from the home's path", async () => {
    const at = await home();
    mkdirSync(stateOf(at), { recursive: true });
    const squatted: Server[] = [];
    for (const key of [stateOf(at), join(stateOf(at), "junto.db"), join(stateOf(at), HOME_LOCK_FILE), at]) {
      const name = `\0junto-home-${createHash("sha256").update(key).digest("hex")}`;
      const server = createServer();
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(name, resolve); });
      squatted.push(server);
    }
    cleanups.push(() => { for (const server of squatted) server.close(); });
    expect((await take(at)).held()).toBe(true);
  });

  it("refuses a lock file whose id was never written, after its creator's wait", async () => {
    const at = await home();
    mkdirSync(stateOf(at), { recursive: true, mode: 0o700 });
    writeFileSync(join(stateOf(at), HOME_LOCK_FILE), "", { mode: 0o600 });
    await expect(acquireHomeLock(at)).rejects.toMatchObject({ reason: "unsafe", message: expect.stringContaining("remove it and start Junto again") });
  });
});
