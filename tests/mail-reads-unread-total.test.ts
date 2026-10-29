/**
 * What the operator has not read in a seat, over every thread of it (0.11.3):
 * the number the seat header shows. A seat with more threads than one page
 * holds counts all of them, and unreadPast decides each thread: a seat's own
 * reply is mail the operator has not read, so it counts like any other.
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
import { seat as seatNode, wire } from "./support/model-nodes";
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
import { markRead, unreadTotal } from "../src/main/junto/work/mail-reads";
import { createMainAuthoringGate } from "../src/main/junto/main-authoring-gate";

const CANVAS = "unread-total";

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
  return ManagedRuntime.make(Layer.mergeAll(Layer.provideMerge(WorkLive, canvasesLive), PausePlaneAllPlaying));
};

const seat = (id: string, x: number) =>
  seatNode(id, { x, y: 40, width: 120, height: 48, bindingId: `bind-${id}` as never, launch: { kind: "harness", argv: ["claude"] } });

let root: string;
let runtime: ReturnType<typeof makeRuntime>;
let server: WorkControlServer;
const tokens: Record<string, string> = {};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-unread-total-"));
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
  for (const id of ["agent", "peer"]) {
    tokens[id] = publishSeatCredential(server.credentials, { agentKey: `local:${id}` });
  }
  await runtime.runPromise(
    seedCanvas(
      CANVAS,
      [seat("agent", 0), seat("peer", 160)],
      [wire("agent-peer", "agent", "peer", "messages"), wire("peer-agent", "peer", "agent", "messages")],
    ),
  );
});

afterEach(async () => {
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

const total = (nodeId: string) => runtime.runPromise(unreadTotal(CANVAS, nodeId));

describe("the operator's unread total for a seat", () => {
  it("counts every thread of the seat, past the page a list holds", async () => {
    // 55 threads, each one mail from the peer: five more than a page of the list.
    const threadIds: string[] = [];
    for (let n = 0; n < 55; n += 1) {
      const opened = await call("peer", "msg.send", { target: "agent", text: `question ${String(n)}` });
      threadIds.push(opened.data.messageId as string);
    }
    expect(await total("agent")).toBe(55);

    // Three read: the total falls by exactly those, wherever they sit in the order.
    for (const threadId of [threadIds[0]!, threadIds[30]!, threadIds[54]!]) {
      expect(await runtime.runPromise(markRead(CANVAS, "agent", threadId))).toBeDefined();
    }
    expect(await total("agent")).toBe(52);

    // Mail arriving in a thread the operator had read is unread again: the seat's own reply too,
    // because the operator has not read it, then the peer's.
    const reply = await call("agent", "msg.reply", { target: "peer", text: "on it", inReplyTo: threadIds[0]! });
    expect(reply.data.messageId).toBeDefined();
    expect(await total("agent")).toBe(53);
    // The peer answers the seat's reply, the mail it holds of the thread.
    const second = await call("peer", "msg.reply", { target: "agent", text: "and this", inReplyTo: reply.data.messageId });
    expect(second.ok, JSON.stringify(second).slice(0, 300)).toBe(true);
    expect(await total("agent")).toBe(54);
  });

  it("answers undefined, never zero, when the count cannot be read", async () => {
    // A canvas that is not there: zero would tell the operator nothing is waiting.
    expect(await runtime.runPromise(unreadTotal("nowhere", "agent"))).toBeUndefined();
  });

  it("counts one seat's mail, not the other's", async () => {
    const opened = await call("peer", "msg.send", { target: "agent", text: "just this one" });
    expect(opened.data.messageId).toBeDefined();
    // The peer's own mailbox holds the mail it sent, which the operator wrote none of.
    expect(await total("peer")).toBeGreaterThanOrEqual(0);
    expect(await total("agent")).toBe(1);
  });
});
