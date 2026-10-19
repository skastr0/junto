/**
 * Reading a peer in one call, over the real work-control socket: `seat read`
 * names who the peer is, since when it has been in its state, when its
 * terminal last printed, its live preamble, and the newest mail between the
 * two seats; `seat wait --until replied` answers when the peer mails back;
 * `seat read --brief` gives all of it for every readable peer at once. Every store, home and socket lives under a temp root.
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
import { WorkLive, WorkService } from "../src/main/junto/work/service";
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
import { liveSeatPreamble, noteSeatPreamble } from "../src/main/junto/work/seat-preambles";

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
  for (const id of ["agent", "peer", "loner", "mute"]) {
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
        seat("mute", 2200),
      ],
      [
        wire("agent-peer", "agent", "peer", "messages"),
        wire("peer-agent", "peer", "agent", "messages"),
        wire("loner-peer", "loner", "peer", "messages"),
        // Mail only: the agent may not read this seat.
        wire("agent-mute", "agent", "mute", "messages", { mask: ["msg.send"] }),
      ],
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

describe("seat read gives the peer's live preamble", () => {
  it("carries the peer's own last preamble, and none for a seat that said nothing", async () => {
    expect((await call("agent", "seat.read", { target: "peer" })).data.preamble).toBeUndefined();
    expect((await call("peer", "preamble", { text: "first thought" })).ok).toBe(true);
    const said = await call("peer", "preamble", { text: "reading the mail plane" });
    expect(said.ok).toBe(true);
    const read = await call("agent", "seat.read", { target: "peer" });
    expect(read.data.preamble).toEqual({ text: "reading the mail plane", expiresAt: said.data.expiresAt });
    // The caller's own preamble is not the peer's.
    expect((await call("peer", "seat.read", { target: "agent" })).data.preamble).toBeUndefined();
  });

  it("drops a preamble once it expires", () => {
    noteSeatPreamble(CANVAS, "ghost", { text: "gone soon", expiresAt: 1_000 });
    expect(liveSeatPreamble(CANVAS, "ghost", 999)).toEqual({ text: "gone soon", expiresAt: 1_000 });
    expect(liveSeatPreamble(CANVAS, "ghost", 1_000)).toBeUndefined();
    expect(liveSeatPreamble(CANVAS, "ghost", 0)).toBeUndefined();
  });
});

describe("seat read gives the newest mail between the two seats", () => {
  const send = async (as: string, target: string, text: string, extra: object = {}) => {
    const sent = await call(as, "msg.send", { target, text, ...extra });
    expect(sent.ok).toBe(true);
    return sent.data.messageId as string;
  };

  it("returns the five newest both ways, newest first, with threads, and marks nothing read", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 4; index++) ids.push(await send("agent", "peer", `ask ${index}`));
    const reply = await call("peer", "msg.reply", { target: "agent", text: "answer to ask 3", inReplyTo: ids[3] });
    expect(reply.ok).toBe(true);
    const replyId = reply.data.messageId as string;
    await send("loner", "peer", "not between agent and peer");
    ids.push(await send("agent", "peer", "x".repeat(300)));
    const readStamps = async () => Object.fromEntries((await Promise.all(["agent", "peer"].map((nodeId) =>
      runtime.runPromise(Effect.flatMap(WorkService, (work) => work.readMailbox(CANVAS, nodeId))))))
      .flat().map((message) => [message.messageId, message.metadata?.readAt]));
    const stampsBefore = await readStamps();

    const read = await call("agent", "seat.read", { target: "peer" });
    expect(read.ok).toBe(true);
    const mail = read.data.mail as Array<Record<string, any>>;
    expect(mail.map((item) => item.messageId)).toEqual([ids[4], replyId, ids[3], ids[2], ids[1]]);
    expect(mail.map((item) => item.direction)).toEqual(["sent", "received", "sent", "sent", "sent"]);
    expect(mail[1]).toMatchObject({ threadId: ids[3], kind: "notice", gist: "answer to ask 3" });
    expect(mail[0]!.gist).toBe("x".repeat(200));
    expect(mail[0]!.sentAt).toBeGreaterThan(0);
    // Replying read the parent; the others are unread.
    expect(mail.map((item) => item.readAt !== undefined)).toEqual([false, false, true, false, false]);

    // The peer reads the same conversation from its side.
    const back = await call("peer", "seat.read", { target: "agent" });
    expect(back.data.mail[0]).toMatchObject({ messageId: ids[4], direction: "received" });

    // Reading marked nothing read on either side.
    expect(await readStamps()).toEqual(stampsBefore);
  });

  it("is empty for two seats that never wrote", async () => {
    expect((await call("agent", "seat.read", { target: "peer" })).data.mail).toEqual([]);
  });
});

describe("seat wait --until replied", () => {
  const send = async (as: string, target: string, text: string) => {
    const sent = await call(as, "msg.send", { target, text });
    expect(sent.ok).toBe(true);
    return sent.data.messageId as string;
  };

  it("answers with the peer's mail to the caller, and not with the caller's own", async () => {
    const waiting = call("agent", "seat.wait", { target: "peer", until: "replied", timeoutMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await send("agent", "peer", "my own mail never answers my wait");
    await send("loner", "peer", "nor does a third seat's");
    const replyId = await send("peer", "agent", "here is the answer");
    const answered = await waiting;
    expect(answered.ok).toBe(true);
    expect(answered.data).toMatchObject({ target: "peer", reason: "replied" });
    expect(answered.data.reply).toMatchObject({ messageId: replyId, direction: "received", gist: "here is the answer" });
  });

  it("times out when only the caller wrote", async () => {
    const waiting = call("agent", "seat.wait", { target: "peer", until: "replied", timeoutMs: 600 });
    await send("agent", "peer", "anyone there?");
    const answered = await waiting;
    expect(answered.ok).toBe(false);
    expect(answered.error).toMatchObject({ type: "Timeout", details: { to: "replied" } });
  });

  it("counts mail before the wait only past the --after cursor", async () => {
    const first = await send("peer", "agent", "first");
    // No cursor: mail from before the wait began does not answer it.
    const fresh = await call("agent", "seat.wait", { target: "peer", until: "replied", timeoutMs: 400 });
    expect(fresh.error?.type).toBe("Timeout");
    // A cursor before it: it answers at once.
    const ask = await send("agent", "peer", "earlier ask");
    const second = await send("peer", "agent", "second");
    const past = await call("agent", "seat.wait", { target: "peer", until: "replied", after: ask, timeoutMs: 2_000 });
    expect(past.data.reply.messageId).toBe(second);
    // A cursor at the newest: it waits for the next one.
    const atNewest = await call("agent", "seat.wait", { target: "peer", until: "replied", after: second, timeoutMs: 400 });
    expect(atNewest.error?.type).toBe("Timeout");
    expect(first < second).toBe(true);
  });

  it("refuses --after on a state wait", async () => {
    const refused = await call("agent", "seat.wait", {
      target: "peer", until: "idle", after: "01M59CMKZRATKFG5E69JZM0BT0",
    });
    expect(refused.ok).toBe(false);
    expect(refused.error.type).toBe("InputError");
  });
});

describe("seat read --brief", () => {
  it("gives every readable peer without screens, and counts the seats left out", async () => {
    await call("peer", "preamble", { text: "on the brief" });
    const sent = await call("agent", "msg.send", { target: "peer", text: "status?" });
    const brief = await call("agent", "seat.read", { brief: true });
    expect(brief.ok).toBe(true);
    expect(brief.data.withheld).toBe(1);
    expect(brief.data.peers).toHaveLength(1);
    const [peer] = brief.data.peers;
    expect(peer).toMatchObject({
      target: "peer",
      peer: { nodeId: "peer", name: "peer", regions: [{ id: "outer", name: "CLI" }, { id: "inner", name: "Protocol" }] },
      preamble: { text: "on the brief" },
    });
    expect(peer.mail.map((mail: { messageId: string }) => mail.messageId)).toEqual([sent.data.messageId]);
    expect(peer).not.toHaveProperty("text");
    expect(JSON.stringify(brief.data)).not.toContain("mute");
  });

  it("refuses a target, a window, or no target without brief", async () => {
    expect((await call("agent", "seat.read", { brief: true, target: "peer" })).error.type).toBe("InputError");
    expect((await call("agent", "seat.read", { brief: true, lines: 5 })).error.type).toBe("InputError");
    expect((await call("agent", "seat.read", {})).error.type).toBe("InputError");
  });
});
