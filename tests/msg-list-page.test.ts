/**
 * `msg list` reads a page, not a mailbox: the items, `more` and `remaining`
 * it answers are the page of the whole mailbox, newest first, and listing
 * marks only the rows it listed. Over the real work-control socket, so the
 * worker's page read, the service's fallback and the handler's wiring are all
 * exercised as the app runs them.
 */
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
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
import { RulingRecorderLive } from "../src/main/junto/work/ruling-recorder";
import { TaskRepositoryLive } from "../src/main/junto/work/task-repository";

const CANVAS = "paging";

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
  const tasksLive = Layer.provide(TaskRepositoryLive, RulingRecorderLive);
  const canvasesLive = Layer.provideMerge(Layer.mergeAll(ModelStoresLive, tasksLive), repositoriesLive);
  return ManagedRuntime.make(Layer.mergeAll(Layer.provideMerge(WorkLive, canvasesLive), PausePlaneAllPlaying));
};

const ME = "agent";
const PEER = "peer";

let root: string;
let runtime: ReturnType<typeof makeRuntime>;
let server: WorkControlServer;
let mine = "";
let peerToken = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-msg-list-page-"));
  const workHome = join(root, "work");
  mkdirSync(workHome, { recursive: true });
  process.env.JUNTO_WORK_HOME = workHome;
  runtime = makeRuntime(root);
  await runtime.runPromise(nameThisMachine);
  await runtime.runPromise(
    seedCanvas(
      CANVAS,
      [region("region", { x: -40, y: -40, width: 900, height: 300 }, { label: "Canvas" }), seatNode(ME, { x: 0 }), seatNode(PEER, { x: 200 })],
      [wire("edge", ME, PEER, "messages")],
    ),
  );
  server = await startWorkControlServer({
    version: "test",
    workHome,
    home: root,
    run: (effect) => runtime.runPromise(effect),
    authoringGate: createMainAuthoringGate(),
  });
  mine = publishSeatCredential(server.credentials, { agentKey: `local:${ME}` });
  peerToken = publishSeatCredential(server.credentials, { agentKey: `local:${PEER}` });
});

afterEach(async () => {
  await server.close();
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
  delete process.env.JUNTO_WORK_HOME;
});

const call = (token: string, op: string, args: unknown): Promise<any> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ path: server.socketPath });
    let buffer = "";
    socket.on("connect", () => socket.write(encodeWorkFrame({ token, op, args })));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)));
    });
    socket.on("error", reject);
  });

const send = async (token: string, from: string, target: string, text: string): Promise<string> => {
  const response = await call(token, "msg.send", { target, text });
  expect(response.ok, JSON.stringify(response)).toBe(true);
  return response.data.messageId as string;
};

describe("msg list pages", () => {
  it("answers the page of the whole inbox, newest first, and marks only what it listed", async () => {
    const sent: string[] = [];
    for (let i = 0; i < 7; i += 1) sent.push(await send(peerToken, PEER, ME, `mail ${i}`));
    const newestFirst = [...sent].sort((a, b) => b.localeCompare(a));

    const first = await call(mine, "msg.list", { limit: 2 });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(first.data.items.map((item: any) => item.messageId)).toEqual(newestFirst.slice(0, 2));
    expect(first.data).toMatchObject({ more: true, remaining: 5 });
    // Listing marks the rows it listed, and only those.
    for (const item of first.data.items) expect(typeof item.metadata?.readAt).toBe("number");

    const second = await call(mine, "msg.list", { limit: 2, before: first.data.items[1].messageId });
    expect(second.data.items.map((item: any) => item.messageId)).toEqual(newestFirst.slice(2, 4));
    expect(second.data).toMatchObject({ more: true, remaining: 3 });

    const rest = await call(mine, "msg.list", { limit: 50, before: second.data.items[1].messageId });
    expect(rest.data.items.map((item: any) => item.messageId)).toEqual(newestFirst.slice(4));
    expect(rest.data).toMatchObject({ more: false, remaining: 0 });

    // A page read again comes back with the same stamps: marking is idempotent.
    const again = await call(mine, "msg.list", { limit: 2 });
    expect(again.data.items.map((item: any) => item.metadata?.readAt)).toEqual(
      first.data.items.map((item: any) => item.metadata?.readAt),
    );
  });

  it("a peek marks nothing and pages the same rows", async () => {
    for (let i = 0; i < 3; i += 1) await send(peerToken, PEER, ME, `unread ${i}`);
    const peeked = await call(mine, "msg.list", { limit: 2, peek: true });
    expect(peeked.data.items).toHaveLength(2);
    for (const item of peeked.data.items) expect(item.metadata?.readAt).toBeUndefined();
    // Still unread after the peek: the next listing marks it, for the first time.
    const listed = await call(mine, "msg.list", { limit: 2 });
    for (const item of listed.data.items) expect(typeof item.metadata?.readAt).toBe("number");
    expect(listed.data.remaining).toBe(1);
  });

  it("pages the seat's own sent mail, each row in the mailbox it sits in", async () => {
    const sent: string[] = [];
    for (let i = 0; i < 3; i += 1) sent.push(await send(mine, ME, PEER, `sent ${i}`));
    const newestFirst = [...sent].sort((a, b) => b.localeCompare(a));

    const page = await call(mine, "msg.list", { limit: 2 });
    expect(page.data.sent.map((item: any) => item.messageId)).toEqual(newestFirst.slice(0, 2));
    expect(page.data.sent.map((item: any) => item.toNodeId)).toEqual([PEER, PEER]);
    expect(page.data).toMatchObject({ sentMore: true, sentRemaining: 1 });

    const rest = await call(mine, "msg.list", { limit: 5, sentBefore: page.data.sent[1].messageId });
    expect(rest.data.sent.map((item: any) => item.messageId)).toEqual(newestFirst.slice(2));
    expect(rest.data).toMatchObject({ sentMore: false, sentRemaining: 0 });
  });
});
