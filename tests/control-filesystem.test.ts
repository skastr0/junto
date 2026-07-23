import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONTROL_DIRECTORY_MODE, CONTROL_FILE_MODE, prepareControlDirectory, removeObservedSocket, rotateControlFileToken } from "../src/main/vellum/control-filesystem";

const roots: string[] = [];
const root = async () => { const path = await mkdtemp(join(tmpdir(), "vellum-control-fs-")); roots.push(path); return path; };
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("control filesystem lifecycle", () => {
  it("normalizes a pre-existing directory to 0700", async () => {
    const path = join(await root(), "control"); mkdirSync(path, { mode: 0o777 }); chmodSync(path, 0o777);
    prepareControlDirectory(path);
    expect(lstatSync(path).mode & 0o777).toBe(CONTROL_DIRECTORY_MODE);
  });

  it("refuses symlink and regular-file stale socket paths without touching targets", async () => {
    const base = await root(); const target = join(base, "target"); const link = join(base, "control.sock");
    writeFileSync(target, "keep"); symlinkSync(target, link);
    await expect(removeObservedSocket(link)).rejects.toThrow(/non-socket/);
    expect(readFileSync(target, "utf8")).toBe("keep"); expect(lstatSync(link).isSymbolicLink()).toBe(true);
    const file = join(base, "file.sock"); writeFileSync(file, "keep");
    await expect(removeObservedSocket(file)).rejects.toThrow(/non-socket/); expect(readFileSync(file, "utf8")).toBe("keep");
  });

  it("removes only an actual stale Unix socket", async () => {
    const path = join(await root(), "control.sock"); const server = createServer();
    await new Promise<void>((resolve) => server.listen(path, resolve));
    await expect(removeObservedSocket(path)).rejects.toThrow(/live|ambiguous/);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("does not follow a pre-created token temporary symlink and preserves its target", async () => {
    const base = await root(); const token = join(base, "token"); const target = join(base, "target"); const leaf = "known";
    writeFileSync(target, "keep"); symlinkSync(target, `${token}.${leaf}.tmp`);
    expect(() => rotateControlFileToken(token, "a".repeat(64), leaf)).toThrow();
    expect(readFileSync(target, "utf8")).toBe("keep"); expect(existsSync(token)).toBe(false);
  });

  it("publishes a 0600 token and replaces a token symlink without following it", async () => {
    const base = await root(); const token = join(base, "token"); const target = join(base, "target");
    writeFileSync(target, "keep"); symlinkSync(target, token);
    const value = rotateControlFileToken(token, "b".repeat(64), "fresh");
    expect(value).toBe("b".repeat(64)); expect(readFileSync(target, "utf8")).toBe("keep");
    expect(lstatSync(token).isSymbolicLink()).toBe(false); expect(lstatSync(token).mode & 0o777).toBe(CONTROL_FILE_MODE);
  });
});
