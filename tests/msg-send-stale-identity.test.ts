/**
 * A seat whose identity goes stale while its mail is being written gets the
 * truth back over the real work-control socket: mail that landed is answered
 * ok, once, so an agent never retries it into a second copy, and a send or
 * reply refused as stale has written nothing at all. Every store, home and
 * socket lives under a temp root.
 */
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeWorkFrame } from "../src/shared/work-control";
import type { Message } from "../src/shared/work-model";
import { publishSeatCredential } from "./helpers/seat-credential";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { seat as seatNode, wire } from "./support/model-nodes";
import { startWorkControlServer, type WorkControlServer } from "../src/main/junto/work/control";
import { messageDelivery } from "../src/main/junto/work/message-delivery";
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

const CANVAS = "stale-send";

// Runs inside the reads every send and reply make before they write.
let duringPrelude: (() => void) | undefined;

/** The live WorkService, with its prelude reads calling `duringPrelude` first. */
const PreludeHookLive = Layer.effect(WorkService, Effect.gen(function* () {
  const work = yield* WorkService;
  return {
    ...work,
    readMailbox: (canvas, nodeId) =>
      Effect.sync(() => duringPrelude?.()).pipe(Effect.andThen(work.readMailbox(canvas, nodeId))),
    readMailMessage: (canvas, nodeId, messageId) =>
      Effect.sync(() => duringPrelude?.()).pipe(Effect.andThen(work.readMailMessage(canvas, nodeId, messageId))),
  } satisfies typeof WorkService.Service;
}));

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
  const workLive = Layer.provideMerge(Layer.provide(PreludeHookLive, WorkLive), canvasesLive);
  return ManagedRuntime.make(Layer.mergeAll(workLive, PausePlaneAllPlaying));
};

const seat = (id: string, label: string, x: number) =>
  seatNode(id, {
    label,
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
  root = await mkdtemp(join(tmpdir(), "junto-stale-send-"));
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
  for (const id of ["sender", "reader"]) {
    tokens[id] = publishSeatCredential(server.credentials, { agentKey: `local:${id}` });
  }
  await runtime.runPromise(
    seedCanvas(
      CANVAS,
      [seat("sender", "sender", 0), seat("reader", "reader", 200)],
      [wire("sender-reader", "sender", "reader", "messages"), wire("reader-sender", "reader", "sender", "messages")],
    ),
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  duringPrelude = undefined;
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

const mailbox = (nodeId: string): Promise<ReadonlyArray<Message>> =>
  runtime.runPromise(Effect.flatMap(WorkService, (work) => work.readMailbox(CANVAS, nodeId)));

describe("a send whose identity goes stale after its mail is written", () => {
  it.each(["msg.send", "msg.prompt"])("%s answers ok with the one message that landed", async (op) => {
    const deliver = messageDelivery.deliver.bind(messageDelivery);
    // The mail is in the store; the sender's generation ends before delivery answers.
    vi.spyOn(messageDelivery, "deliver").mockImplementation((canvas, nodeId, messageId) => {
      // The append's own listener delivers too; the first call ends the generation.
      server.credentials.revoke(tokens.sender!, "offboarded");
      return deliver(canvas, nodeId, messageId);
    });

    const sent = await call("sender", op, { target: "reader", text: "lands once" });

    expect(sent.error).toBeUndefined();
    expect(server.credentials.lookup(tokens.sender!).status).not.toBe("live");
    expect((await mailbox("reader")).map((message) => message.messageId)).toEqual([sent.data.messageId]);
  });

  it("the stale credential is refused on its next call, with nothing written", async () => {
    expect(server.credentials.revoke(tokens.sender!, "offboarded")).toBe(true);

    const refused = await call("sender", "msg.send", { target: "reader", text: "never lands" });

    expect(refused.ok).toBe(false);
    expect(refused.error.type).toBe("AuthError");
    expect(await mailbox("reader")).toEqual([]);
  });
});

describe("a send or reply whose identity goes stale before it writes", () => {
  const isStale = (answer: any) => {
    expect(answer.ok).toBe(false);
    expect(answer.error.type).toBe("AuthError");
    expect(answer.error.message).toMatch(/identity became stale/);
  };

  it("msg send in a thread is refused at its write and nothing lands", async () => {
    const first = await call("sender", "msg.send", { target: "reader", text: "first" });
    expect(first.ok).toBe(true);
    duringPrelude = () => server.credentials.revoke(tokens.sender!, "offboarded");

    isStale(await call("sender", "msg.send", { target: "reader", text: "never lands", threadId: first.data.messageId }));

    expect((await mailbox("reader")).map((message) => message.messageId)).toEqual([first.data.messageId]);
  });

  it("msg reply is refused at its write: no reply, and the parent stays unread", async () => {
    const asked = await call("sender", "msg.send", { target: "reader", text: "status?" });
    expect(asked.ok).toBe(true);
    duringPrelude = () => server.credentials.revoke(tokens.reader!, "offboarded");

    isStale(await call("reader", "msg.reply", { target: "sender", text: "never lands", inReplyTo: asked.data.messageId }));

    expect(await mailbox("sender")).toEqual([]);
    const [parent] = await mailbox("reader");
    expect(parent?.messageId).toBe(asked.data.messageId);
    expect(parent?.metadata?.readAt).toBeUndefined();
  });
});
