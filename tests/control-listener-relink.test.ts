/**
 * One listener per control path, also when the home under it is relinked.
 * A home that is a symlink, replaced by a fresh directory under a running
 * core, resolved somewhere new, so a second core took a lease and listened
 * beside the first under the same path text (remote-verify, VM B). The lease
 * now holds the written path as well as the resolved one.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireControlListenerLease,
  controlListenerLeaseHeld,
  prepareControlDirectory,
  releaseControlListenerLease,
  removeObservedSocket,
  type ControlListenerLease,
} from "../src/node/control-filesystem";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const root = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "junto-relink-"));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
};
const socketOf = (home: string): string => join(home, ".junto", "operator", "control.sock");

/** A core's operator listener on `home`, taken as src/node/operator-control/server.ts takes it. */
const listen = async (home: string): Promise<{ lease: ControlListenerLease; close: () => Promise<void> }> => {
  const path = socketOf(home);
  prepareControlDirectory(join(home, ".junto", "operator"));
  const lease = await acquireControlListenerLease(path);
  let server: Server | undefined;
  try {
    await removeObservedSocket(lease);
    const listening = createServer((socket) => socket.end());
    await new Promise<void>((resolve, reject) => { listening.once("error", reject); listening.listen({ path }, resolve); });
    server = listening;
  } catch (error) {
    await releaseControlListenerLease(lease);
    throw error;
  }
  let closed: Promise<void> | undefined;
  const close = () => (closed ??= new Promise<void>((resolve) => server!.close(() => resolve())).then(() => releaseControlListenerLease(lease)));
  cleanups.push(close);
  return { lease, close };
};

const unshareMounts = process.platform === "linux" && spawnSync("unshare", ["-rm", "true"]).status === 0;

describe.skipIf(process.platform !== "linux")("a control listener under a relinked home", () => {
  it("refuses a second core when the home symlink is replaced by a fresh directory under a live one", async () => {
    const base = await root();
    mkdirSync(join(base, "real"));
    symlinkSync(join(base, "real"), join(base, "far"));
    const first = await listen(join(base, "far"));
    rmSync(join(base, "far"), { recursive: true, force: true });
    mkdirSync(join(base, "far"));
    await expect(listen(join(base, "far"))).rejects.toThrow("control listener lease unavailable");
    expect(controlListenerLeaseHeld(first.lease)).toBe(true);
  });

  it("still refuses a second core when a plain home is deleted under a live one", async () => {
    const base = await root();
    const first = await listen(join(base, "far"));
    rmSync(join(base, "far"), { recursive: true, force: true });
    await expect(listen(join(base, "far"))).rejects.toThrow("control listener lease unavailable");
    expect(controlListenerLeaseHeld(first.lease)).toBe(true);
  });

  it("still refuses a second core through a symlink to a live one's home", async () => {
    const base = await root();
    await listen(join(base, "real"));
    symlinkSync(join(base, "real"), join(base, "link"));
    await expect(listen(join(base, "link"))).rejects.toThrow("control listener lease unavailable");
  });

  it.skipIf(!unshareMounts)("still refuses a second core on a bind-mounted second view of a live one's home", async () => {
    const base = await root();
    await listen(join(base, "real"));
    mkdirSync(join(base, "view"));
    // A bind mount does not resolve to its source, so the lease keys differ;
    // the live listener seen through the second view refuses it.
    const child = `
      const { acquireControlListenerLease, prepareControlDirectory, removeObservedSocket } = await import(${JSON.stringify(pathToFileURL(fileURLToPath(new URL("../src/node/control-filesystem.ts", import.meta.url))).href)});
      const path = process.argv[1] + "/.junto/operator/control.sock";
      try {
        prepareControlDirectory(process.argv[1] + "/.junto/operator");
        const lease = await acquireControlListenerLease(path);
        await removeObservedSocket(lease);
        console.log("STARTED");
      } catch (error) { console.log("REFUSED " + error.message); }`;
    const run = spawnSync("unshare", ["-rm", "sh", "-c", 'mount --bind "$1" "$2" && exec "$3" -e "$4" "$2"', "sh",
      join(base, "real"), join(base, "view"), "bun", child], { encoding: "utf8", timeout: 20_000 });
    expect(run.stderr).toBe("");
    expect(run.stdout.trim()).toBe("REFUSED refusing to replace control socket with a live listener");
  });

  it("starts again once the old core has closed, on a relinked home and on a plain one", async () => {
    const base = await root();
    mkdirSync(join(base, "real"));
    symlinkSync(join(base, "real"), join(base, "far"));
    await (await listen(join(base, "far"))).close();
    rmSync(join(base, "far"), { recursive: true, force: true });
    mkdirSync(join(base, "far"));
    await (await listen(join(base, "far"))).close();
    const plain = await listen(join(base, "plain"));
    await plain.close();
    expect(controlListenerLeaseHeld(plain.lease)).toBe(false);
    await expect(listen(join(base, "plain"))).resolves.toBeDefined();
  });
});
