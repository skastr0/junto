/**
 * PROTO-8 — a paused seat reports paused:true and a next_step through the
 * real work control socket, so an agent can tell a pause from a broken grant.
 *
 * Wiring and fakes are documented in tests/pty-e2e/proto-harness.ts.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConnection } from "node:net";
import { encodeWorkFrame } from "../../../src/shared/work-control";
import type { CanvasDoc } from "../../../src/shared/canvas";
import { ProtoHarness } from "../proto-harness";
import { startWorkControlServer, type WorkControlServer } from "../../../src/main/junto/work/control";
import { createMainAuthoringGate } from "../../../src/main/junto/main-authoring-gate";
import { makeProcessIdentityMap } from "../../../src/main/junto/process-identity";

const seatNode = (id: string, bindingId?: string): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 0,
  width: 120,
  height: 48,
  ether: {
    entity: { kind: "agent", name: `local:${id}` },
    terminal: {
      bindingId: bindingId ?? `bind-${id}`,
      harness: "claude",
      launch: { kind: "harness", argv: ["claude"] },
    },
  },
});

const kindNode = (id: string, kind: string): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: id,
  x: 200,
  y: 0,
  width: 120,
  height: 48,
  ether: { entity: { kind } },
});

const edge = (id: string, fromNode: string, toNode: string) => ({
  id,
  fromNode,
  toNode,
});

const docWith = (nodes: CanvasDoc["nodes"], edges: CanvasDoc["edges"]): CanvasDoc => ({
  nodes,
  edges,
});

const call = (socketPath: string, body: unknown): Promise<{
  readonly ok: boolean;
  readonly data?: Record<string, unknown>;
  readonly error?: { readonly type: string; readonly details?: { readonly next_step?: string } };
}> =>
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

const controlSeedDoc = (): CanvasDoc => docWith(
  [
    seatNode("agent"),
    kindNode("tasks", "task"),
    kindNode("req", "requests"),
    kindNode("artifacts", "artifacts"),
  ],
  [
    edge("e1", "agent", "tasks"),
    edge("e2", "agent", "req"),
    edge("e3", "agent", "artifacts"),
  ],
);

describe("PROTO-8 — paused seat reports paused:true + next_step", () => {
  let harness: ProtoHarness;
  let server: WorkControlServer;
  const roots: string[] = [];

  beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), "junto-proto8-"));
    roots.push(root);
    const canvasesDir = join(root, "canvases");
    const workHome = join(root, "work");
    mkdirSync(canvasesDir, { recursive: true });
    mkdirSync(workHome, { recursive: true });
    process.env.JUNTO_CANVASES_DIR = canvasesDir;
    process.env.JUNTO_WORK_HOME = workHome;
    harness = new ProtoHarness({ root });
    await harness.start();
    await harness.setStationCommandCenter();
    await harness.writeDoc("work-cli", controlSeedDoc());
    const processMap = makeProcessIdentityMap();
    processMap.bind(process.pid, { agentKey: "local:agent" });
    server = await startWorkControlServer({
      version: "test",
      workHome,
      home: root,
      processMap,
      readPeerPid: () => process.pid,
      run: (effect) => harness.runtime.runPromise(effect as never),
      authoringGate: createMainAuthoringGate(),
    });
  });

  afterAll(async () => {
    if (server) await server.close();
    if (harness) await harness.dispose();
    for (const root of roots) {
      try {
        const { rm } = await import("node:fs/promises");
        await rm(root, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  it("capabilities for a born-paused canvas lacks paused (expected paused:true + next_step)", async () => {
    // The canvas was never played — the factory pause law says it is paused.
    const state = harness.pause.stateFor("work-cli");
    expect(state.playing).toBe(false);
    const res = await call(server.socketPath, {
      token: readFileSync(server.tokenPath, "utf8").trim(),
      op: "capabilities",
    });
    expect(res.ok).toBe(true);
    // PRODUCT LAW: a paused seat must surface paused:true + next_step so the
    // agent can distinguish pause from a broken grant. ACTUAL today: absent.
    expect(res.data?.paused).toBe(true);
    expect(res.data?.next_step).toEqual(expect.stringContaining("resume"));
  });

  it("onboard for a paused seat lacks paused (expected paused:true + next_step)", async () => {
    const res = await call(server.socketPath, {
      token: readFileSync(server.tokenPath, "utf8").trim(),
      op: "onboard",
    });
    expect(res.ok).toBe(true);
    expect(res.data?.paused).toBe(true);
    expect(res.data?.next_step).toEqual(expect.stringContaining("resume"));
  });

  it("gate sanity: a paused seat still refuses mutating ops with a Paused error (works today)", async () => {
    const res = await call(server.socketPath, {
      token: readFileSync(server.tokenPath, "utf8").trim(),
      op: "tasks.create",
      args: { target: "tasks", brief: "do the thing", metadata: { details: "sanity gate" } },
    });
    expect(res.ok).toBe(false);
    expect(res.error?.type).toBe("Paused");
    expect(res.error?.details?.next_step).toContain("resume");
  });

  it("node-paused inside a playing canvas also lacks paused in capabilities", async () => {
    await harness.runtime.runPromise(harness.pause.setPlaying("work-cli", true));
    await harness.runtime.runPromise(
      harness.pause.setScopePaused("work-cli", { kind: "node", id: "agent" }, true),
    );
    const res = await call(server.socketPath, {
      token: readFileSync(server.tokenPath, "utf8").trim(),
      op: "capabilities",
    });
    expect(res.ok).toBe(true);
    expect(res.data?.paused).toBe(true);
    expect(res.data?.next_step).toEqual(expect.stringContaining("resume"));
  });
});
