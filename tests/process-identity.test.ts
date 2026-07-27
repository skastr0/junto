import { createConnection, createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  admitProcessIdentity,
  configurePeerPidHelperRoots,
  makeProcessIdentityMap,
  processAlive,
  readProcessStartKey,
  readUnixPeerPid,
  readUnixPeerProcessChain,
} from "../src/main/vellum/process-identity";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("process identity epoch", () => {
  it("binds only live PIDs and resolves with start-key match", () => {
    const map = makeProcessIdentityMap();
    const pid = process.pid;
    expect(processAlive(pid)).toBe(true);
    expect(readProcessStartKey(pid)).toBeTruthy();
    expect(map.bind(pid, { agentKey: "local:default" })).toBe(true);
    expect(map.resolve(pid)?.agentKey).toBe("local:default");
    map.unbindAgentKey("local:default");
    expect(map.resolve(pid)).toBeUndefined();
  });

  it("refuses to overwrite a live PID with a different principal", () => {
    const map = makeProcessIdentityMap();
    const pid = process.pid;
    expect(map.bind(pid, { agentKey: "local:a" })).toBe(true);
    expect(map.bind(pid, { agentKey: "local:b" })).toBe(false);
    expect(map.resolve(pid)?.agentKey).toBe("local:a");
    map.clear();
  });

  it("unbindAgentKey clears prior binds before rebind", () => {
    const map = makeProcessIdentityMap();
    const pid = process.pid;
    map.bind(pid, { agentKey: "local:a" });
    map.unbindAgentKey("local:a");
    expect(map.bind(pid, { agentKey: "local:a" })).toBe(true);
    map.clear();
  });

  it("binds and unbinds canvas-anchored terminal principals", () => {
    const map = makeProcessIdentityMap();
    const principal = {
      kind: "terminal" as const,
      bindingId: "term-1",
      canvasName: "main",
      nodeId: "node-1",
    };
    expect(map.bind(process.pid, principal)).toBe(true);
    expect(map.resolve(process.pid)).toEqual(principal);
    map.unbindTerminalBinding("term-1");
    expect(map.resolve(process.pid)).toBeUndefined();
  });

  it("rejects terminal principals without a canvas anchor", () => {
    const map = makeProcessIdentityMap();
    expect(map.bind(process.pid, { bindingId: "term-1" })).toBe(false);
  });
});

describe("process identity peer PID (real UDS)", () => {
  it("reads peer PID via sealed helper on a real Unix socket", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-peer-pid-"));
    roots.push(root);
    // Point helper roots at the repo scripts/ (absolute) — same as dev main.
    const repoScripts = join(process.cwd(), "scripts");
    configurePeerPidHelperRoots([repoScripts]);

    const socketPath = join(root, "t.sock");
    const peerPid = await new Promise<number | undefined>((resolve, reject) => {
      const server = createServer((socket) => {
        try {
          resolve(readUnixPeerPid(socket));
        } catch (error) {
          reject(error);
        } finally {
          socket.destroy();
          server.close();
        }
      });
      server.on("error", reject);
      server.listen(socketPath, () => {
        const client = createConnection({ path: socketPath });
        client.on("error", reject);
        client.on("connect", () => {
          // keep open until server reads peer
        });
      });
      setTimeout(() => reject(new Error("timeout")), 5_000);
    });

    expect(peerPid).toBe(process.pid);
  });

  it("captures stable exact-executable ancestry from a real Unix socket", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-peer-chain-"));
    roots.push(root);
    configurePeerPidHelperRoots([join(process.cwd(), "scripts")]);

    const socketPath = join(root, "t.sock");
    const observation = await new Promise<
      ReturnType<typeof readUnixPeerProcessChain>
    >((resolve, reject) => {
      const server = createServer((socket) => {
        try {
          resolve(readUnixPeerProcessChain(socket));
        } catch (error) {
          reject(error);
        } finally {
          socket.destroy();
          server.close();
        }
      });
      server.on("error", reject);
      server.listen(socketPath, () => {
        const client = createConnection({ path: socketPath });
        client.on("error", reject);
      });
      setTimeout(() => reject(new Error("timeout")), 5_000);
    });

    expect(observation?.peerPid).toBe(process.pid);
    expect(observation?.chain[0]).toMatchObject({
      pid: process.pid,
      uid: process.getuid?.(),
    });
    expect(observation?.chain[0]?.executable).toMatch(/^\//u);
    expect(observation?.chain[0]?.startKey).toMatch(/^[0-9]+(?::[0-9]+)?$/u);
    expect(observation?.chain[0]?.inode).toMatch(/^[1-9][0-9]*$/u);
  });

  it("admits via injected peer reader and process map", () => {
    const map = makeProcessIdentityMap();
    map.bind(process.pid, { agentKey: "local:default" });
    const fake = {} as import("node:net").Socket;
    const result = admitProcessIdentity(fake, map, () => process.pid);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.principal.agentKey).toBe("local:default");
    map.clear();
  });
});
