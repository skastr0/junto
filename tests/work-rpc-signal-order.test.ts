/**
 * A signal raised in a thread, after other signals, or in a batch, across the
 * work socket (orders 7 and 8; docs/security-doctrine.md, after the no-edge
 * signals line). In a thread the signal and the seat's mail there are one
 * act; what a signal comes after is the seat's own, existing signals; a batch
 * is written whole and in order. Every refusal writes nothing: no signal row,
 * no mail row.
 */
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WORK_TOKEN_ENV, encodeWorkFrame } from "../src/shared/work-control";
import { OperatorThreadSend } from "../src/shared/mail-threads";
import { OPERATOR_SEAT_ID } from "../src/shared/work-reference";
import { signalThreadFault } from "../src/shared/signal-thread";
import { publishSeatCredential } from "./helpers/seat-credential";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { region, seat as seatNode, wire } from "./support/model-nodes";
import { startWorkControlServer, type WorkControlServer } from "../src/core/work/control";
import { WorkLive, WorkService } from "../src/core/work/service";
import { CrewRepositoryLive } from "../src/core/work/crew-repository";
import { makeContentServiceLive } from "../src/core/content/service";
import { WorkRepositoryLive } from "../src/core/work/repository";
import { OpRepositoryLive } from "../src/core/work/op-repository";
import { AgentSignalPersistenceError, AgentSignalRepository, AgentSignalRepositoryLive } from "../src/core/signals/repository";
import { makeStateEngineLive } from "../src/core/state/engine";
import { makeInstallOpsLive } from "../src/core/install-ops/engine";
import { MachineRepositoryLive } from "../src/core/machines/repository";
import { SettingsLive } from "../src/core/settings/service";
import { nameThisMachine } from "./support/name-this-machine";
import { PausePlaneAllPlaying } from "../src/core/pause-plane";
import { createMainAuthoringGate } from "../src/node/main-authoring-gate";
import { RulingRecorderLive } from "../src/core/work/ruling-recorder";
import { TaskRepositoryLive } from "../src/core/work/task-repository";
import { ArtifactRepositoryLive } from "../src/core/work/artifact-repository";
import { sendOperatorThreadMail } from "../src/core/work/operator-threads";
import { threadRow } from "../src/core/work-control/signal-raise";
import { makeTestLog } from "./support/test-log";

const testLog = makeTestLog();

const CANVAS = "signal-order";
const ME = "agent";
const PEER = "peer";
/** A raise whose text holds this fails in the store, after its mail was written. */
const FAIL = "STORE REFUSES THIS";

/** The store as it is, save that a raise naming FAIL fails: the rollback's witness. */
const FailingSignalsLive = Layer.effect(
  AgentSignalRepository,
  Effect.map(Effect.service(AgentSignalRepository), (real) =>
    AgentSignalRepository.of({
      ...real,
      raise: (input) =>
        input.text.includes(FAIL)
          ? Effect.fail(new AgentSignalPersistenceError({ operation: "raise", message: "refused for the test", cause: undefined }))
          : real.raise(input),
    }),
  ),
).pipe(Layer.provide(AgentSignalRepositoryLive));

const makeRuntime = (root: string) => {
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      MachineRepositoryLive,
      SettingsLive,
      OpRepositoryLive,
      FailingSignalsLive,
      makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
    ),
    Layer.mergeAll(
      makeStateEngineLive(join(root, "state", "junto.db")),
      makeInstallOpsLive(join(root, "state", "install-ops.db")),
    ),
  );
  const rulersLive = Layer.provide(Layer.mergeAll(TaskRepositoryLive, ArtifactRepositoryLive), RulingRecorderLive);
  const canvasesLive = Layer.provideMerge(Layer.mergeAll(ModelStoresLive, rulersLive), repositoriesLive);
  return ManagedRuntime.make(Layer.mergeAll(Layer.provideMerge(WorkLive, canvasesLive), PausePlaneAllPlaying, testLog.log.loggerLayer));
};

let root: string;
let runtime: ReturnType<typeof makeRuntime>;
let server: WorkControlServer;
let mine = "";
let peers = "";

const run = <A>(effect: Effect.Effect<A, unknown, any>): Promise<A> => runtime.runPromise(effect as Effect.Effect<A, unknown, never>);

const decodeSend = Schema.decodeUnknownSync(OperatorThreadSend);

/** The operator writes a new thread into a seat's mailbox, as the desktop does. */
const operatorWrites = async (nodeId: string, text: string): Promise<string> => {
  const written = await run(sendOperatorThreadMail(decodeSend({ canvasName: CANVAS, nodeId, text })));
  return (written as { threadId: string }).threadId;
};

/** A v1 frame as a seat writes it, and the frame the core answers. */
const call = (op: string, args: unknown, token = mine): Promise<any> =>
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

/** What is written: every signal of the seat, and every row of its mailbox. */
const written = async () => {
  const signals = await run(Effect.flatMap(Effect.service(AgentSignalRepository), (store) => store.listSeat({ canvasName: CANVAS, nodeId: ME }, { fromMs: 0 })));
  const mail = await run(Effect.flatMap(Effect.service(WorkService), (work) => work.readMailbox(CANVAS, ME)));
  return { signals: signals.length, mail: mail.length, rows: mail };
};

/** A refusal: the error frame, and nothing written. */
const refusedWritingNothing = async (op: string, args: unknown) => {
  const before = await written();
  const answer = await call(op, args);
  expect(answer.ok, JSON.stringify(answer)).toBe(false);
  const after = await written();
  expect({ signals: after.signals, mail: after.mail }).toEqual({ signals: before.signals, mail: before.mail });
  return answer.error as { type: string; message: string; details?: Record<string, unknown> };
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-work-rpc-signal-order-"));
  const workHome = join(root, "work");
  mkdirSync(workHome, { recursive: true });
  process.env.JUNTO_WORK_HOME = workHome;
  runtime = makeRuntime(root);
  await run(nameThisMachine);
  await run(
    seedCanvas(
      CANVAS,
      [region("region", { x: -40, y: -40, width: 800, height: 300 }, { label: "Canvas" }), seatNode(ME, { x: 0 }), seatNode(PEER, { x: 200 })],
      [wire("edge", ME, PEER, "messages"), wire("back", PEER, ME, "messages")],
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
  peers = publishSeatCredential(server.credentials, { agentKey: `local:${PEER}` });
});

afterEach(async () => {
  await server.close();
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
  delete process.env.JUNTO_WORK_HOME;
  delete process.env[WORK_TOKEN_ENV];
});

describe("a signal raised in a thread", () => {
  it("is one act: the signal, and the seat's next mail there answering the operator's newest", async () => {
    const threadId = await operatorWrites(ME, "Which store for the run log?");
    const answer = await call("signal.raise", { kind: "escalate", text: "Sqlite, unless you want JSON kept.", thread: threadId });
    expect(answer.ok, JSON.stringify(answer)).toBe(true);
    const signal = answer.data.signal;
    expect(signal).toMatchObject({ threadId });
    const { rows } = await written();
    const mail = rows.find((row) => row.messageId === signal.messageId);
    expect(mail?.role).toBe("agent");
    expect(mail?.metadata).toMatchObject({ threadId, inReplyTo: threadId, toNodeId: "operator", raisedSignalId: signal.signalId });
    // The pointer is the one signal field the row carries; the words are text only.
    expect(mail?.metadata).not.toHaveProperty("agentSignalId");
    expect(mail?.metadata).not.toHaveProperty("attachments");
    expect(mail?.parts.every((part) => part.kind === "text")).toBe(true);
  });

  it("takes the id of any mail in the thread, and follows the signal before it there", async () => {
    const threadId = await operatorWrites(ME, "Two questions for you.");
    const first = (await call("signal.raise", { kind: "escalate", text: "First question.", thread: threadId })).data.signal;
    const second = await call("signal.raise", { kind: "blocked", text: "Second question.", thread: first.messageId });
    expect(second.ok, JSON.stringify(second)).toBe(true);
    expect(second.data.signal).toMatchObject({ threadId, followsSignalId: first.signalId });
    expect(first).not.toHaveProperty("followsSignalId");
  });

  it("is refused, writing nothing, in a thread the operator wrote nothing in to this seat", async () => {
    const sent = await call("msg.send", { target: ME, text: "Peer to agent, no operator here." }, peers);
    expect(sent.ok, JSON.stringify(sent)).toBe(true);
    const { rows } = await written();
    const peerMail = rows.find((row) => row.metadata?.fromSeat !== OPERATOR_SEAT_ID)!;
    const error = await refusedWritingNothing("signal.raise", { kind: "escalate", text: "In the peer's thread.", thread: peerMail.messageId });
    expect(error.type).toBe("ScopeError");
  });

  it("is refused, writing nothing, for a thread this seat does not hold and for an id that is no ULID", async () => {
    await operatorWrites(PEER, "Only the peer's.");
    const unknown = await refusedWritingNothing("signal.raise", { kind: "escalate", text: "Not mine.", thread: "01M852PM9NWTBBVNYYPSPR0HNV" });
    expect(unknown.type).toBe("UnknownTarget");
    const notUlid = await refusedWritingNothing("signal.raise", { kind: "escalate", text: "Bad id.", thread: "thread-1" });
    expect(notUlid.type).toBe("InputError");
  });

  it("writes no mail when the signal is refused by the store after its mail", async () => {
    const threadId = await operatorWrites(ME, "A question.");
    const error = await refusedWritingNothing("signal.raise", { kind: "escalate", text: `The store ${FAIL}.`, thread: threadId });
    expect(error.type).toBe("InternalError");
  });

  it("reads a row with no stamp as not the operator's", () => {
    const row = threadRow({ messageId: "01M852PM9NWTBBVNYYPSPR0HNV" });
    expect(row.actorSeatId).toBeUndefined();
    expect(signalThreadFault("01M852PM9NWTBBVNYYPSPR0HNV", [row])).toBe("no_operator_row");
  });
});

describe("a signal that comes after others", () => {
  it("names this seat's own signals, and --depends-on-last the one it raised last", async () => {
    const first = (await call("signal.raise", { kind: "escalate", text: "Topic one." })).data.signal;
    const second = await call("signal.raise", { kind: "escalate", text: "Topic two.", dependsOnLast: true });
    expect(second.data.signal.dependsOn).toEqual([first.signalId]);
    const third = await call("signal.raise", { kind: "escalate", text: "Topic three.", dependsOn: [first.signalId, second.data.signal.signalId] });
    expect(third.data.signal.dependsOn).toEqual([first.signalId, second.data.signal.signalId]);
    const listed = (await call("signal.list", {})).data.signals;
    const byId = new Map(listed.map((signal: { signalId: string }) => [signal.signalId, signal]));
    expect(byId.get(first.signalId)).toMatchObject({ ready: true, waitingOn: [] });
    expect(byId.get(third.data.signal.signalId)).toMatchObject({ ready: false, waitingOn: [first.signalId, second.data.signal.signalId] });
  });

  it("with --depends-on-last and no earlier signal, comes after nothing", async () => {
    const answer = await call("signal.raise", { kind: "escalate", text: "The first ever.", dependsOnLast: true });
    expect(answer.ok, JSON.stringify(answer)).toBe(true);
    expect(answer.data.signal.dependsOn ?? []).toEqual([]);
  });

  it("is refused, writing nothing, for another seat's signal, an unknown one, more than eight, or no ULID", async () => {
    const theirs = (await call("signal.raise", { kind: "escalate", text: "The peer's." }, peers)).data.signal;
    expect((await refusedWritingNothing("signal.raise", { kind: "escalate", text: "After theirs.", dependsOn: [theirs.signalId] })).type).toBe("UnknownTarget");
    expect((await refusedWritingNothing("signal.raise", { kind: "escalate", text: "After none.", dependsOn: ["01M852PM9NWTBBVNYYPSPR0HNV"] })).type).toBe("UnknownTarget");
    const nine = Array.from({ length: 9 }, () => theirs.signalId);
    expect((await refusedWritingNothing("signal.raise", { kind: "escalate", text: "After nine.", dependsOn: nine })).type).toBe("InputError");
    expect((await refusedWritingNothing("signal.raise", { kind: "escalate", text: "After junk.", dependsOn: ["junk"] })).type).toBe("InputError");
  });
});

describe("what a signal comes after, as the handler judges it before the store", () => {
  it("counts --depends-on-last after the ids it names, and refuses a ninth, writing nothing", async () => {
    const mineAll: Array<string> = [];
    for (let index = 0; index < 9; index += 1) {
      mineAll.push((await call("signal.raise", { kind: "feedback", text: `Signal ${index + 1}.` })).data.signal.signalId);
    }
    const eight = mineAll.slice(0, 8);
    // The last is the ninth, not among the eight: nine in all.
    const error = await refusedWritingNothing("signal.raise", { kind: "escalate", text: "After nine.", dependsOn: eight, dependsOnLast: true });
    expect(error).toMatchObject({ type: "InputError", details: { path: "args.dependsOn" } });
    // The last among the eight counts once.
    const deduped = await call("signal.raise", { kind: "escalate", text: "After eight.", dependsOn: [...mineAll.slice(1, 8), mineAll[8]], dependsOnLast: true });
    expect(deduped.ok, JSON.stringify(deduped)).toBe(true);
    expect(deduped.data.signal.dependsOn).toHaveLength(8);
  });

  it("refuses an automation's signal in the seat's words, writing nothing", async () => {
    const automations = await run(
      Effect.flatMap(Effect.service(AgentSignalRepository), (store) =>
        store.raise({
          canvasName: CANVAS,
          nodeId: ME,
          kind: "feedback",
          text: "An automation raised this.",
          source: { kind: "automation", automationId: "01M852PM9NWTBBVNYYPSPR0HNV", nodeId: ME },
        }),
      ),
    );
    const error = await refusedWritingNothing("signal.raise", { kind: "escalate", text: "After the automation's.", dependsOn: [automations.signalId] });
    expect(error.type).toBe("ScopeError");
    expect(error.message).toContain("a signal can only come after one this seat raised itself");
    const inBatch = await refusedWritingNothing("signal.batch", { signals: [{ kind: "escalate", text: "One.", dependsOn: [automations.signalId] }] });
    expect(inBatch.message).toContain("a signal can only come after one this seat raised itself");
  });
});

describe("junto signal batch", () => {
  it("raises in the order given, each after the one before unless it says otherwise", async () => {
    const earlier = (await call("signal.raise", { kind: "feedback", text: "Earlier." })).data.signal;
    const answer = await call("signal.batch", {
      signals: [
        { kind: "escalate", text: "One." },
        { kind: "escalate", text: "Two." },
        { kind: "escalate", text: "Three.", dependsOn: [1] },
        { kind: "feedback", text: "Four.", dependsOn: [] },
        { kind: "blocked", text: "Five.", dependsOn: [2, earlier.signalId] },
      ],
    });
    expect(answer.ok, JSON.stringify(answer)).toBe(true);
    const ids = answer.data.signals.map((signal: { signalId: string }) => signal.signalId);
    expect(answer.data.signals.map((signal: { text: string }) => signal.text)).toEqual(["One.", "Two.", "Three.", "Four.", "Five."]);
    expect(answer.data.signals.map((signal: { dependsOn?: string[] }) => signal.dependsOn ?? [])).toEqual([
      [],
      [ids[0]],
      [ids[0]],
      [],
      [ids[1], earlier.signalId],
    ]);
  });

  it("is refused whole, writing nothing, for a position its own or later, a bad item, or more than fifty", async () => {
    const own = await refusedWritingNothing("signal.batch", { signals: [{ kind: "escalate", text: "One." }, { kind: "escalate", text: "Two.", dependsOn: [2] }] });
    expect(own).toMatchObject({ type: "InputError", details: { path: "args.signals[1].dependsOn[0]" } });
    const later = await refusedWritingNothing("signal.batch", { signals: [{ kind: "escalate", text: "One.", dependsOn: [2] }, { kind: "escalate", text: "Two." }] });
    expect(later.type).toBe("InputError");
    const bad = await refusedWritingNothing("signal.batch", { signals: [{ kind: "escalate", text: "One." }, { kind: "feedback", text: "" }] });
    expect(bad.type).toBe("InputError");
    const many = Array.from({ length: 51 }, (_, index) => ({ kind: "escalate", text: `Topic ${index + 1}.` }));
    expect((await refusedWritingNothing("signal.batch", { signals: many })).type).toBe("InputError");
  });

  it("writes none of the batch when the store refuses a later item, its mail in a thread included", async () => {
    const threadId = await operatorWrites(ME, "A thread for the batch.");
    const error = await refusedWritingNothing("signal.batch", {
      signals: [
        { kind: "escalate", text: "One, in the thread.", thread: threadId },
        { kind: "escalate", text: `Two, which ${FAIL}.` },
      ],
    });
    expect(error.type).toBe("InternalError");
  });
});

describe("a seat whose canvas another machine edits", () => {
  it("raises plain signals, and is refused, writing nothing, a thread, an order or a batch", async () => {
    const threadId = await operatorWrites(ME, "A question.");
    await run(
      Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) => sql`UPDATE canvases SET editor_installation_id = ${"another-installation"} WHERE canvas_name = ${CANVAS}`),
    );
    const plain = await call("signal.raise", { kind: "escalate", text: "Plain, as today." });
    expect(plain.ok, JSON.stringify(plain)).toBe(true);
    for (const [op, args] of [
      ["signal.raise", { kind: "escalate", text: "In a thread.", thread: threadId }],
      ["signal.raise", { kind: "escalate", text: "After it.", dependsOn: [plain.data.signal.signalId] }],
      ["signal.raise", { kind: "escalate", text: "After the last.", dependsOnLast: true }],
      ["signal.batch", { signals: [{ kind: "escalate", text: "One." }] }],
    ] as const) {
      const error = await refusedWritingNothing(op, args);
      expect(error).toMatchObject({ type: "ScopeError", details: { reason: "other_machine" } });
      expect(error.details?.next_step).toBeDefined();
    }
  });
});
