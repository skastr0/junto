import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireControlListenerLease,
  captureControlSocketPathIdentity,
  controlListenerLeaseHeld,
  controlSocketPathOwnedByLease,
  CONTROL_DIRECTORY_MODE,
  CONTROL_FILE_MODE,
  prepareControlDirectory,
  releaseControlListenerLease,
  removeObservedSocket,
  removeOwnedControlSocketPath,
  rotateControlFileToken,
  type ControlListenerLease,
} from "../src/main/vellum/control-filesystem";

const roots: string[] = [];
const root = async () => { const path = await mkdtemp(join(tmpdir(), "vellum-control-fs-")); roots.push(path); return path; };
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const staleSocket = async (path: string): Promise<void> => {
  const stage = `${path}.stage`; const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(stage, resolve); });
  renameSync(stage, path);
  await new Promise<void>((resolve) => server.close(() => resolve()));
};
const withLease = async (
  path: string,
  use: (lease: ControlListenerLease) => Promise<void>,
): Promise<void> => {
  const lease = await acquireControlListenerLease(path);
  try {
    await use(lease);
  } finally {
    if (controlListenerLeaseHeld(lease)) {
      await releaseControlListenerLease(lease);
    }
  }
};

describe("control filesystem lifecycle", () => {
  it("normalizes a pre-existing directory to 0700", async () => {
    const path = join(await root(), "control"); mkdirSync(path, { mode: 0o777 }); chmodSync(path, 0o777);
    prepareControlDirectory(path);
    expect(lstatSync(path).mode & 0o777).toBe(CONTROL_DIRECTORY_MODE);
  });

  it("refuses a symlinked control root without chmodding its target", async () => {
    const base = await root(); const target = join(base, "target"); const link = join(base, "control");
    mkdirSync(target, { mode: 0o755 }); chmodSync(target, 0o755); symlinkSync(target, link);
    expect(() => prepareControlDirectory(link)).toThrow();
    expect(lstatSync(target).mode & 0o777).toBe(0o755);
  });

  it("refuses symlink and regular-file stale socket paths without touching targets", async () => {
    const base = await root(); const target = join(base, "target"); const link = join(base, "control.sock");
    writeFileSync(target, "keep"); symlinkSync(target, link);
    await withLease(link, async (lease) => {
      await expect(removeObservedSocket(lease)).rejects.toThrow(/non-socket/);
      expect(readFileSync(target, "utf8")).toBe("keep"); expect(lstatSync(link).isSymbolicLink()).toBe(true);
    });
    const file = join(base, "file.sock"); writeFileSync(file, "keep");
    await withLease(file, async (lease) => {
      await expect(removeObservedSocket(lease)).rejects.toThrow(/non-socket/);
      expect(readFileSync(file, "utf8")).toBe("keep");
    });
  });

  it("removes only an actual stale Unix socket", async () => {
    const path = join(await root(), "control.sock"); await staleSocket(path);
    await withLease(path, async (lease) => {
      expect(lstatSync(path).isSocket()).toBe(true);
      await removeObservedSocket(lease);
      expect(existsSync(path)).toBe(false);
    });
  });

  it("refuses a live foreign Unix listener and leaves it connectable", async () => {
    const path = join(await root(), "control.sock");
    let accepted = 0;
    const server = createServer((socket) => {
      accepted += 1;
      socket.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
    try {
      await withLease(path, async (lease) => {
        await expect(removeObservedSocket(lease)).rejects.toThrow(/live listener/);
        expect(lstatSync(path).isSocket()).toBe(true);

        const client = createConnection({ path });
        await new Promise<void>((resolve, reject) => {
          client.once("connect", resolve);
          client.once("error", reject);
        });
        client.destroy();
      });
      expect(accepted).toBeGreaterThanOrEqual(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("excludes a second startup before and after listener activation, then releases", async () => {
    const path = join(await root(), "control.sock");
    const first = await acquireControlListenerLease(path);
    const server = createServer();
    try {
      await expect(acquireControlListenerLease(path)).rejects.toThrow();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, resolve);
      });
      await expect(acquireControlListenerLease(path)).rejects.toThrow();
      expect(controlListenerLeaseHeld(first)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await releaseControlListenerLease(first);
    }

    const next = await acquireControlListenerLease(path);
    expect(controlListenerLeaseHeld(next)).toBe(true);
    await releaseControlListenerLease(next);
    expect(controlListenerLeaseHeld(next)).toBe(false);
  });

  it("rejects fabricated and released cleanup authority", async () => {
    const path = join(await root(), "control.sock");
    await staleSocket(path);
    await expect(
      removeObservedSocket({} as ControlListenerLease),
    ).rejects.toThrow(/invalid control listener lease/);
    const lease = await acquireControlListenerLease(path);
    await releaseControlListenerLease(lease);
    await expect(removeObservedSocket(lease)).rejects.toThrow(/not held/);
    expect(lstatSync(path).isSocket()).toBe(true);
  });

  it("fails a deterministic replacement race before moving the replacement", async () => {
    const base = await root(); const path = join(base, "control.sock"); const replacement = join(base, "replacement");
    await staleSocket(path); writeFileSync(replacement, "foreign");
    await withLease(path, async (lease) => {
      await expect(removeObservedSocket(lease, { beforeQuarantineRename: () => renameSync(replacement, path) })).rejects.toThrow(/changed before quarantine/);
    });
    const quarantines = (await (await import("node:fs/promises")).readdir(base)).filter((name) => name.startsWith(".vellum-stale-"));
    expect(quarantines).toHaveLength(1);
    expect(readFileSync(path, "utf8")).toBe("foreign");
    expect(existsSync(join(base, quarantines[0]!, "control.sock"))).toBe(false);
  });

  it("uses the lease and captured inode as the only live-path cleanup authority", async () => {
    const path = join(await root(), "control.sock");
    await withLease(path, async (lease) => {
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, resolve);
      });
      const identity = captureControlSocketPathIdentity(lease);
      expect(controlSocketPathOwnedByLease(lease, identity)).toBe(true);
      expect(removeOwnedControlSocketPath(lease, identity)).toBe(true);
      expect(existsSync(path)).toBe(false);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
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
