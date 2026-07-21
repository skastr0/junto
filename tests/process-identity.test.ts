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
    expect(map.bind(pid, { kind: "agent", agentKey: "local:default" })).toBe(true);
    expect(map.resolve(pid)?.agentKey).toBe("local:default");
    map.unbindAgentKey("local:default");
    expect(map.resolve(pid)).toBeUndefined();
  });

  it("refuses to overwrite a live PID with a different principal", () => {
    const map = makeProcessIdentityMap();
    const pid = process.pid;
    expect(map.bind(pid, { kind: "agent", agentKey: "local:a" })).toBe(true);
    expect(map.bind(pid, { kind: "agent", agentKey: "local:b" })).toBe(false);
    expect(map.resolve(pid)?.agentKey).toBe("local:a");
    map.clear();
  });

  it("unbindAgentKey clears prior binds before rebind", () => {
    const map = makeProcessIdentityMap();
    const pid = process.pid;
    map.bind(pid, { kind: "agent", agentKey: "local:a" });
    map.unbindAgentKey("local:a");
    expect(map.bind(pid, { kind: "agent", agentKey: "local:a" })).toBe(true);
    map.clear();
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

  it("admits via injected peer reader and process map", () => {
    const map = makeProcessIdentityMap();
    map.bind(process.pid, { kind: "agent", agentKey: "local:default" });
    const fake = {} as import("node:net").Socket;
    const result = admitProcessIdentity(fake, map, () => process.pid);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.principal.agentKey).toBe("local:default");
    map.clear();
  });
});
