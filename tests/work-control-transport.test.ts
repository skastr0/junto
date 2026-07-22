import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect, Layer, ManagedRuntime } from "effect";
import { formatNodeRef } from "../src/shared/node-ref";
import {
  WORK_PROTOCOL_VERSION,
  decodeWorkResponse,
  encodeWorkFrame,
  workControlTokenPath,
} from "../src/shared/work-control";
import { CanvasesLive, CanvasesService } from "../src/main/vellum/canvases";
import {
  startWorkControlServer,
  type WorkControlServer,
} from "../src/main/vellum/work/control";
import { WorkLive, WorkService } from "../src/main/vellum/work/service";
import { makeProcessIdentityMap } from "../src/main/vellum/process-identity";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  createMainAuthoringGate,
  type MainAuthoringGate,
} from "../src/main/vellum/main-authoring-gate";

const roots: string[] = [];
const servers: WorkControlServer[] = [];
const runtimes: Array<ManagedRuntime.ManagedRuntime<WorkService | CanvasesService, never>> = [];
const authoringGates: MainAuthoringGate[] = [];
/** Peer PID for transport tests — must be a live process (epoch-checked). */
const TEST_PEER_PID = process.pid;

const seedDoc = (): CanvasDoc => ({
  nodes: [
    {
      id: "agent",
      type: "text",
      x: 0,
      y: 0,
      width: 120,
      height: 48,
      text: "agent",
      ether: { entity: { kind: "agent", name: "local:agent" } },
    },
    {
      id: "tasks",
      type: "text",
      x: 200,
      y: 0,
      width: 120,
      height: 48,
      text: "tasks",
      ether: {
        entity: { kind: "task" },
        tasks: {
          items: [
            {
              id: "t1",
              state: "submitted",
              history: [
                {
                  messageId: "m0",
                  role: "user",
                  parts: [{ kind: "text", text: "ship it" }],
                  contextId: "work-cli",
                  taskId: "t1",
                },
              ],
            },
          ],
        },
      },
    },
    {
      id: "orphan-tasks",
      type: "text",
      x: 500,
      y: 200,
      width: 120,
      height: 48,
      text: "orphan",
      ether: { entity: { kind: "task" }, tasks: { items: [] } },
    },
  ],
  edges: [{ id: "e1", fromNode: "agent", toNode: "tasks" }],
});

const call = (
  socketPath: string,
  body: unknown,
): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timeout"));
    }, 5_000);
    socket.on("connect", () => {
      socket.write(encodeWorkFrame(body));
    });
    socket.on("data", (chunk: Buffer | string) => {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buf = Buffer.concat([buf, part]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return;
      clearTimeout(timer);
      const line = buf.subarray(0, nl).toString("utf8");
      socket.destroy();
      resolve(JSON.parse(line));
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "vellum-work-ctl-"));
  roots.push(root);
  const canvasesDir = join(root, "canvases");
  const workHome = join(root, "work");
  mkdirSync(canvasesDir, { recursive: true });
  mkdirSync(workHome, { recursive: true });
  process.env.VELLUM_CANVASES_DIR = canvasesDir;
  process.env.VELLUM_WORK_HOME = workHome;

  writeFileSync(join(canvasesDir, "work-cli.canvas"), JSON.stringify(seedDoc()), {
    encoding: "utf8",
  });

  const runtime = ManagedRuntime.make(Layer.provideMerge(WorkLive, CanvasesLive));
  runtimes.push(runtime);

  const processMap = makeProcessIdentityMap();
  processMap.bind(TEST_PEER_PID, {
    kind: "agent",
    agentKey: "local:agent",
  });

  const authoringGate = createMainAuthoringGate();
  authoringGates.push(authoringGate);
  const server = await startWorkControlServer({
    version: "test",
    workHome,
    home: root,
    canvasesDir,
    processMap,
    readPeerPid: () => TEST_PEER_PID,
    run: (effect) => runtime.runPromise(effect),
    authoringGate,
  });
  servers.push(server);
});

afterEach(async () => {
  while (servers.length > 0) servers.pop()?.close();
  while (runtimes.length > 0) {
    const rt = runtimes.pop();
    if (rt) await rt.dispose();
  }
  authoringGates.length = 0;
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
  delete process.env.VELLUM_CANVASES_DIR;
  delete process.env.VELLUM_WORK_HOME;
});

const nodeRef = formatNodeRef({ canvasName: "work-cli", nodeId: "agent" });

const token = (): string => {
  const workHome = process.env.VELLUM_WORK_HOME!;
  return readFileSync(workControlTokenPath(workHome), "utf8").trim();
};

describe("work control transport", () => {
  it("mints 0600 socket + token", async () => {
    const server = servers[0]!;
    const sockMode = (await stat(server.socketPath)).mode & 0o777;
    const tokMode = (await stat(server.tokenPath)).mode & 0o777;
    expect(sockMode).toBe(0o600);
    expect(tokMode).toBe(0o600);
  });

  it("ping + doctor over NDJSON", async () => {
    const server = servers[0]!;
    const pong = await call(server.socketPath, {
      token: token(),
      op: "ping",
    });
    const decoded = decodeWorkResponse(pong);
    expect(decoded._tag).toBe("Right");
    if (decoded._tag === "Right") {
      expect(decoded.right.ok).toBe(true);
      if (decoded.right.ok) {
        expect((decoded.right.data as { protocol_version: string }).protocol_version).toBe(
          WORK_PROTOCOL_VERSION,
        );
      }
    }
  });

  it("keeps reads available while returning typed RuntimeDown for authorial ops", async () => {
    const server = servers[0]!;
    const gate = authoringGates[0]!;
    const precommit = gate.beginPrecommit();

    const ping = (await call(server.socketPath, {
      token: token(),
      op: "ping",
    })) as { ok: boolean };
    expect(ping.ok).toBe(true);

    const refused = (await call(server.socketPath, {
      token: token(),
      op: "tasks.claim",
      args: { target: "tasks", task: "t1", actor: "agent" },
    })) as {
      ok: false;
      error: { type: string; message: string; details?: { retryable?: boolean } };
    };
    expect(refused.ok).toBe(false);
    expect(refused.error.type).toBe("RuntimeDown");
    expect(refused.error.message).toMatch(/precommit-closed|refused/);
    expect(refused.error.details?.retryable).toBe(false);

    await gate.drain(precommit.epoch);
    gate.recover(precommit.epoch);
    const admitted = (await call(server.socketPath, {
      token: token(),
      op: "tasks.claim",
      args: { target: "tasks", task: "t1", actor: "agent" },
    })) as { ok: boolean };
    expect(admitted.ok).toBe(true);
  });

  it("ignores forged nodeRef — process principal wins", async () => {
    const server = servers[0]!;
    // Client claims a different canvas/node; identity is process-bind only.
    const forged = await call(server.socketPath, {
      token: token(),
      nodeRef: "vellum://canvas/other?node=impostor",
      op: "capabilities",
    });
    const decoded = decodeWorkResponse(forged);
    expect(decoded._tag).toBe("Right");
    if (decoded._tag === "Right") {
      expect(decoded.right.ok).toBe(true);
      if (decoded.right.ok) {
        const data = decoded.right.data as {
          node?: { id?: string };
          connected?: ReadonlyArray<{ id: string }>;
        };
        // Still the process-bound agent card, not the forged impostor.
        expect(data.node?.id).toBe("agent");
        expect(data.connected?.some((c) => c.id === "tasks")).toBe(true);
      }
    }
  });

  it("denies unbound peer regardless of nodeRef", async () => {
    // Spin a one-off server with empty process map.
    const root = await mkdtemp(join(tmpdir(), "vellum-work-unbound-"));
    roots.push(root);
    const workHome = join(root, "work");
    const canvasesDir = join(root, "canvases");
    mkdirSync(workHome, { recursive: true });
    mkdirSync(canvasesDir, { recursive: true });
    writeFileSync(join(canvasesDir, "work-cli.canvas"), JSON.stringify(seedDoc()));
    const runtime = ManagedRuntime.make(Layer.provideMerge(WorkLive, CanvasesLive));
    runtimes.push(runtime);
    const emptyMap = makeProcessIdentityMap();
    const unboundServer = await startWorkControlServer({
      version: "test",
      workHome,
      home: root,
      canvasesDir,
      processMap: emptyMap,
      readPeerPid: () => 99_999,
      run: (effect) => runtime.runPromise(effect),
    });
    servers.push(unboundServer);
    const res = (await call(unboundServer.socketPath, {
      token: readFileSync(workControlTokenPath(workHome), "utf8").trim(),
      nodeRef,
      op: "ping",
    })) as { ok: false; error: { type: string; message: string } };
    expect(res.ok).toBe(false);
    expect(res.error.type).toBe("AuthError");
    expect(res.error.message).toMatch(/not a registered|process/i);
  });

  it("rejects wrong token as AuthError", async () => {
    const server = servers[0]!;
    const res = (await call(server.socketPath, {
      token: "wrong-token-value-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      nodeRef,
      op: "ping",
    })) as { ok: false; error: { type: string } };
    expect(res.ok).toBe(false);
    expect(res.error.type).toBe("AuthError");
  });

  it("survives garbage frames (socket stays up)", async () => {
    const server = servers[0]!;
    // Raw non-JSON line — ProtocolError, connection remains usable for next client.
    const garbage = await new Promise<unknown>((resolve, reject) => {
      const socket = createConnection({ path: server.socketPath });
      let buf = Buffer.alloc(0);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("timeout"));
      }, 5_000);
      socket.on("connect", () => {
        socket.write("{{{{not-json\n");
      });
      socket.on("data", (chunk: Buffer | string) => {
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        buf = Buffer.concat([buf, part]);
        const nl = buf.indexOf(0x0a);
        if (nl < 0) return;
        clearTimeout(timer);
        const line = buf.subarray(0, nl).toString("utf8");
        socket.destroy();
        resolve(JSON.parse(line));
      });
      socket.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    expect((garbage as { ok: boolean }).ok).toBe(false);
    expect((garbage as { error: { type: string } }).error.type).toBe("ProtocolError");

    const second = (await call(server.socketPath, {
      token: token(),
      nodeRef,
      op: "ping",
    })) as { ok: boolean };
    expect(second.ok).toBe(true);
  });

  it("ScopeError on non-connected target", async () => {
    const server = servers[0]!;
    const res = (await call(server.socketPath, {
      token: token(),
      nodeRef,
      op: "tasks.list",
      args: { target: "orphan-tasks" },
    })) as { ok: false; error: { type: string; message: string; details?: { missing?: string } } };
    expect(res.ok).toBe(false);
    expect(res.error.type).toBe("ScopeError");
    expect(res.error.message).toMatch(/edge|connect/i);
  });

  it("claims a connected task", async () => {
    const server = servers[0]!;
    const res = (await call(server.socketPath, {
      token: token(),
      nodeRef,
      op: "tasks.claim",
      args: { target: "tasks", task: "t1", actor: "agent" },
    })) as { ok: true; data: { id: string; state: string; metadata?: { claimedBy?: string } } };
    expect(res.ok).toBe(true);
    expect(res.data.state).toBe("working");
    expect(res.data.metadata?.claimedBy).toBe("agent");
  });

  it("ClaimConflict on second actor", async () => {
    const server = servers[0]!;
    await call(server.socketPath, {
      token: token(),
      nodeRef,
      op: "tasks.claim",
      args: { target: "tasks", task: "t1", actor: "agent" },
    });
    const res = (await call(server.socketPath, {
      token: token(),
      nodeRef,
      op: "tasks.claim",
      args: { target: "tasks", task: "t1", actor: "other" },
    })) as { ok: false; error: { type: string; details?: { holder?: string } } };
    expect(res.ok).toBe(false);
    expect(res.error.type).toBe("ClaimConflict");
    expect(res.error.details?.holder).toBe("agent");
  });

  it("capabilities lists connected ops only", async () => {
    const server = servers[0]!;
    const res = (await call(server.socketPath, {
      token: token(),
      nodeRef,
      op: "capabilities",
    })) as {
      ok: true;
      data: { connected: Array<{ id: string; ops: string[] }> };
    };
    expect(res.ok).toBe(true);
    expect(res.data.connected.map((c) => c.id)).toEqual(["tasks"]);
    expect(res.data.connected[0]?.ops).toContain("tasks.claim");
  });

  it("never echoes token in responses", async () => {
    const server = servers[0]!;
    const res = await call(server.socketPath, {
      token: token(),
      nodeRef,
      op: "onboard",
    });
    const raw = JSON.stringify(res);
    expect(raw).not.toContain(token());
  });
});

// Ensure chmod pattern matches browser control
void chmodSync;
