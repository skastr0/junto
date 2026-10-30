/**
 * What the operator has not read in a seat, over every thread of it (0.11.3):
 * the number the seat header shows. A seat with more threads than one page
 * holds counts all of them, and unreadPast decides each thread: only a seat's
 * reply to the operator counts, never mail between seats (0.11.5).
 */
import { ulid } from "ulid";
import { mailExtensionMetadata } from "../src/shared/crew";
import { makeUserMessage } from "../src/shared/task";
import { operatorActorRef } from "../src/shared/work-reference";
import { WorkService } from "../src/main/junto/work/service";
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
import { markRead, onReadChanged, unreadTotal, unreadTotals } from "../src/main/junto/work/mail-reads";
import { makeSeatUnread } from "../src/main/junto/companion/seat-unread";
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

/** Operator mail into a seat: a new thread, or a row in `threadId`. */
const operatorMail = async (nodeId: string, text: string, threadId?: string): Promise<string> => {
  const sender = operatorActorRef(CANVAS);
  const appended = await runtime.runPromise(
    Effect.flatMap(WorkService, (work) =>
      work.workSystemMailboxNotify(CANVAS, nodeId, makeUserMessage({
        messageId: ulid(),
        text,
        contextId: CANVAS,
        metadata: {
          factoryMail: true,
          ...mailExtensionMetadata({ mailKind: "prompt", fromSeat: sender.seatId, senderNodeId: sender.nodeId, senderName: "operator", senderGeneration: "operator", senderHarness: "unknown" }),
          ...(threadId === undefined ? {} : { threadId }),
        },
      })),
    ),
  );
  if (!appended.ok) throw new Error(appended.message);
  return appended.data.messageId;
};

/** The operator asks the agent, and the agent answers the operator. */
const askedAndAnswered = async (text: string): Promise<string> => {
  const threadId = await operatorMail("agent", text);
  const answered = await call("agent", "msg.reply", { target: "operator", text: `re: ${text}`, inReplyTo: threadId });
  if (!answered.ok) throw new Error(JSON.stringify(answered).slice(0, 300));
  return threadId;
};

const total = (nodeId: string) => runtime.runPromise(unreadTotal(CANVAS, nodeId));

describe("the operator's unread total for a seat", () => {
  it("counts every thread the operator is in, past the page a list holds, and no mail between seats", async () => {
    // Mail between seats, more than a page of it: none of it counts.
    for (let n = 0; n < 55; n += 1) {
      const opened = await call("peer", "msg.send", { target: "agent", text: `between ${String(n)}` });
      expect(opened.ok).toBe(true);
    }
    expect(await total("agent")).toBe(0);

    // 55 threads with the operator, each answered once: five more than a page of the list.
    const threadIds: string[] = [];
    for (let n = 0; n < 55; n += 1) threadIds.push(await askedAndAnswered(`question ${String(n)}`));
    expect(await total("agent")).toBe(55);

    // Three read: the total falls by exactly those, wherever they sit in the order.
    for (const threadId of [threadIds[0]!, threadIds[30]!, threadIds[54]!]) {
      expect(await runtime.runPromise(markRead(CANVAS, "agent", threadId))).toBeDefined();
    }
    expect(await total("agent")).toBe(52);

    // The operator writes in an unread thread: it is read through that mail.
    await operatorMail("agent", "got it", threadIds[1]!);
    expect(await total("agent")).toBe(51);

    // A reply to the operator in a thread they had read counts again.
    const reply = await call("agent", "msg.reply", { target: "operator", text: "one more", inReplyTo: threadIds[0]! });
    expect(reply.ok, JSON.stringify(reply).slice(0, 300)).toBe(true);
    expect(await total("agent")).toBe(52);
  });

  it("answers undefined, never zero, when the count cannot be read", async () => {
    // A canvas that is not there: zero would tell the operator nothing is waiting.
    expect(await runtime.runPromise(unreadTotal("nowhere", "agent"))).toBeUndefined();
  });

  it("counts one seat's thread with the operator, not the other's", async () => {
    await askedAndAnswered("just this one");
    expect(await total("peer")).toBe(0);
    expect(await total("agent")).toBe(1);
  });
});

describe("the phone's seat unread", () => {
  it("moves when the desktop reads a thread with the operator, read once per change however many phones ask", async () => {
    let reads = 0;
    const seats = makeSeatUnread((canvasName, nodeIds) => {
      reads += 1;
      return runtime.runPromise(unreadTotals(canvasName, nodeIds));
    });
    // As the companion wiring does: a moved read point forgets the canvas.
    const off = onReadChanged(({ canvasName }) => seats.forget(canvasName));
    try {
      // Mail between the two seats counts for neither; the agent's answer to the operator counts for it.
      await call("peer", "msg.send", { target: "agent", text: "a thread between the two" });
      const threadId = await askedAndAnswered("a thread with the operator");
      seats.forget(CANVAS); // new mail, as the work change does
      const phones = await Promise.all([seats.totals(CANVAS, ["agent", "peer"]), seats.totals(CANVAS, ["agent", "peer"])]);
      expect(reads).toBe(1);
      expect(phones[0]).toBe(phones[1]);
      expect(Object.fromEntries(phones[0])).toEqual({ agent: 1, peer: 0 });
      expect(await total("agent")).toBe(1);

      // The desktop reads it under one seat (its IPC calls this markRead); the point is the thread's.
      expect(await runtime.runPromise(markRead(CANVAS, "agent", threadId))).toBeDefined();
      expect(Object.fromEntries(await seats.totals(CANVAS, ["agent", "peer"]))).toEqual({ agent: 0, peer: 0 });
      expect(reads).toBe(2);
      // A mark that moves nothing tells no one, so the count is not read again.
      await runtime.runPromise(markRead(CANVAS, "agent", threadId));
      await seats.totals(CANVAS, ["agent"]);
      expect(reads).toBe(2);
    } finally {
      off();
    }
  });

  it("leaves a seat's count out when the counts cannot be read, and reads again next time", async () => {
    const seats = makeSeatUnread((canvasName, nodeIds) => runtime.runPromise(unreadTotals(canvasName, nodeIds)));
    expect((await seats.totals("nowhere", ["agent"])).has("agent")).toBe(false);
    expect(await runtime.runPromise(unreadTotals("nowhere", ["agent"]))).toBeUndefined();
  });
});
