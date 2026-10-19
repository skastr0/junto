/**
 * Reading a peer in one call, over the real work-control socket: `seat read`
 * names who the peer is, since when it has been in its state and when its
 * terminal last printed. Every store, home and socket lives under a temp root.
 */
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeWorkFrame } from "../src/shared/work-control";
import { publishSeatCredential } from "./helpers/seat-credential";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { region, seat as seatNode, wire } from "./support/model-nodes";
import { startWorkControlServer, type WorkControlServer } from "../src/main/junto/work/control";
import { WorkLive } from "../src/main/junto/work/service";
import { CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import { makeContentServiceLive } from "../src/main/junto/content/service";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { MachineRepositoryLive } from "../src/main/junto/machines/repository";
import { SettingsLive } from "../src/main/junto/settings/service";
import { nameThisMachine } from "./support/name-this-machine";
import { PausePlaneAllPlaying } from "../src/main/junto/pause-plane";
import { createMainAuthoringGate } from "../src/main/junto/main-authoring-gate";
import { seatStateRuntime } from "../src/main/junto/term/agent-state";
import { terminalObserverPlane } from "../src/main/junto/term/observer";

const CANVAS = "peers";

const makeRuntime = (root: string) => {
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      MachineRepositoryLive,
      SettingsLive,
      makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
    ),
    Layer.mergeAll(
      makeStateEngineLive(join(root, "state", "junto.db")),
      makeInstallOpsLive(join(root, "state", "install-ops.db")),
    ),
  );
  const canvasesLive = Layer.provideMerge(ModelStoresLive, repositoriesLive);
  const workLive = Layer.provideMerge(WorkLive, canvasesLive);
  return ManagedRuntime.make(Layer.mergeAll(workLive, PausePlaneAllPlaying));
};

const seat = (id: string, x: number) =>
  seatNode(id, {
    x,
    y: 40,
    width: 120,
    height: 48,
    bindingId: `bind-${id}` as never,
    launch: { kind: "harness", argv: ["claude"] },
  });

let root: string;
let runtime: ReturnType<typeof makeRuntime>;
let server: WorkControlServer;
const tokens: Record<string, string> = {};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-seat-read-peer-"));
  const workHome = join(root, "work");
  mkdirSync(workHome, { recursive: true });
  process.env.JUNTO_WORK_HOME = workHome;
  runtime = makeRuntime(root);
  await runtime.runPromise(nameThisMachine);
  server = await startWorkControlServer({
    version: "test",
    workHome,
    home: root,
    run: (effect) => runtime.runPromise(effect),
    authoringGate: createMainAuthoringGate(),
  });
  for (const id of ["agent", "peer", "loner"]) {
    tokens[id] = publishSeatCredential(server.credentials, { agentKey: `local:${id}` });
  }
  await runtime.runPromise(
    seedCanvas(
      CANVAS,
      [
        region("outer", { x: -100, y: -100, width: 1000, height: 600 }, { label: "CLI" }),
        region("inner", { x: 100, y: 0, width: 300, height: 200 }, { label: "Protocol" }),
        seat("agent", 0),
        seat("peer", 160),
        seat("loner", 2000),
      ],
      [wire("agent-peer", "agent", "peer", "messages"), wire("peer-agent", "peer", "agent", "messages")],
    ),
  );
});

afterEach(async () => {
  terminalObserverPlane.detach("bind-peer");
  seatStateRuntime.machine.unbind("bind-peer");
  await server.close();
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
  delete process.env.JUNTO_WORK_HOME;
});

const call = (as: string, op: string, args: unknown = {}): Promise<any> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ path: server.socketPath });
    let buffer = "";
    socket.on("connect", () => socket.write(encodeWorkFrame({ token: tokens[as]!, op, args })));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)));
    });
    socket.on("error", reject);
  });

describe("seat read names the peer", () => {
  it("gives the peer's name and regions outermost first, from the one seat identity", async () => {
    const read = await call("agent", "seat.read", { target: "peer" });
    expect(read.ok).toBe(true);
    expect(read.data.peer).toEqual({
      nodeId: "peer",
      name: "peer",
      regions: [{ id: "outer", name: "CLI" }, { id: "inner", name: "Protocol" }],
    });
    // Nothing published and nothing printed yet: neither time is claimed.
    expect(read.data.since).toBeUndefined();
    expect(read.data.lastActivityAt).toBeUndefined();
  });

  it("dates the peer's state and its last output", async () => {
    const before = Date.now();
    seatStateRuntime.machine.bind("bind-peer", { harness: "claude", epoch: "e1" });
    seatStateRuntime.machine.force("bind-peer", "working", "test_working");
    terminalObserverPlane.attach({ bindingId: "bind-peer", epoch: "e1", cols: 80, rows: 24 });
    terminalObserverPlane.feed("bind-peer", "hello\r\n", 1n);
    const read = await call("agent", "seat.read", { target: "peer" });
    expect(read.ok).toBe(true);
    expect(read.data.state).toBe("working");
    expect(read.data.since).toBeGreaterThanOrEqual(before);
    expect(read.data.lastActivityAt).toBeGreaterThanOrEqual(before);
    expect(read.data.lastActivityAt).toBeLessThanOrEqual(Date.now());
  });

  it("still refuses a seat the caller holds no edge to", async () => {
    const read = await call("agent", "seat.read", { target: "loner" });
    expect(read.ok).toBe(false);
    expect(read.error.type).toBe("ScopeError");
  });
});
