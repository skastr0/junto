/**
 * A signal in a thread, after other signals (0.12, threads parts 7 and 8),
 * as the store keeps it: the thread, its mail, what it follows and what it
 * comes after; the reads a raise in a thread and a batch in order need; the
 * thread an answer starts; and the announcement, made once its write
 * commits, never from a transaction that rolls back.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeStateEngineLive } from "../src/core/state/engine";
import { AgentSignalRepository, AgentSignalRepositoryLive } from "../src/core/signals/repository";
import { onAgentSignalChanged } from "../src/core/signals/changes";
import { AGENT_SIGNAL_MAX_DEPENDS_ON, type AgentSignal } from "../src/shared/agent-signals";

let root: string;
let runtime: ManagedRuntime.ManagedRuntime<AgentSignalRepository | SqlClient.SqlClient, unknown>;
let heard: Array<AgentSignal>;
let stopHearing: () => void;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-signal-thread-"));
  const state = makeStateEngineLive(join(root, "junto.db"));
  runtime = ManagedRuntime.make(Layer.merge(AgentSignalRepositoryLive.pipe(Layer.provide(state)), state));
  heard = [];
  stopHearing = onAgentSignalChanged((signal) => heard.push(signal));
});

afterEach(async () => {
  stopHearing();
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const run = <A, E>(effect: Effect.Effect<A, E, AgentSignalRepository | SqlClient.SqlClient>) => runtime.runPromise(effect);
const repo = AgentSignalRepository;
const seatA = { canvasName: "factory", nodeId: "agent-a" };
const seatB = { canvasName: "factory", nodeId: "agent-b" };

describe("a signal in a thread", () => {
  it("keeps its thread, its mail and what it follows, and reads them back", async () => {
    const thread = ulid();
    const message = ulid();
    const { head, next, listed } = await run(
      Effect.gen(function* () {
        const r = yield* repo;
        const head = yield* r.raise({ ...seatA, kind: "escalate", text: "pick a db", threadId: thread });
        const next = yield* r.raise({
          ...seatA,
          kind: "blocked",
          text: "and the key",
          threadId: thread,
          messageId: message,
          followsSignalId: head.signalId,
        });
        return { head, next, listed: yield* r.listSeat(seatA) };
      }),
    );
    expect(head).toMatchObject({ threadId: thread });
    expect(head).not.toHaveProperty("messageId");
    expect(next).toMatchObject({ threadId: thread, messageId: message, followsSignalId: head.signalId });
    expect(listed.find((signal) => signal.signalId === next.signalId)).toMatchObject({ followsSignalId: head.signalId });
  });

  it("reads a seat's signals in one thread newest first, and no one else's", async () => {
    const thread = ulid();
    const other = ulid();
    const { ids, inThread, inOther, foreign } = await run(
      Effect.gen(function* () {
        const r = yield* repo;
        const first = yield* r.raise({ ...seatA, kind: "feedback", text: "one", threadId: thread });
        yield* r.dismiss(first.signalId);
        const second = yield* r.raise({ ...seatA, kind: "feedback", text: "two", threadId: thread, followsSignalId: first.signalId });
        yield* r.raise({ ...seatA, kind: "feedback", text: "elsewhere", threadId: other });
        yield* r.raise({ ...seatA, kind: "feedback", text: "no thread" });
        yield* r.raise({ ...seatB, kind: "feedback", text: "b's", threadId: thread });
        return {
          ids: [second.signalId, first.signalId],
          inThread: yield* r.listSeatThread(seatA, thread),
          inOther: yield* r.listSeatThread(seatA, other),
          foreign: yield* r.listSeatThread(seatB, thread),
        };
      }),
    );
    expect(inThread.map((signal) => signal.signalId)).toEqual(ids);
    expect(inThread[1]?.state).toBe("dismissed");
    expect(inOther).toHaveLength(1);
    expect(foreign.map((signal) => signal.text)).toEqual(["b's"]);
  });

  it("puts a signal held without a thread into the one its answer starts, once", async () => {
    const thread = ulid();
    const { placed, again, refused } = await run(
      Effect.gen(function* () {
        const r = yield* repo;
        const signal = yield* r.raise({ ...seatA, kind: "escalate", text: "pick" });
        yield* r.answer(signal.signalId, "sqlite");
        const placed = yield* r.setThread(signal.signalId, thread);
        const again = yield* r.setThread(signal.signalId, thread);
        const refused = yield* r.setThread(signal.signalId, ulid()).pipe(Effect.flip);
        return { placed, again, refused };
      }),
    );
    expect(placed).toMatchObject({ threadId: thread, state: "answered" });
    expect(again.threadId).toBe(thread);
    expect(refused._tag).toBe("AgentSignalNotFound");
  });

  it("takes another machine's signal with its thread, and a thread set there later", async () => {
    const thread = ulid();
    const id = ulid();
    const later = ulid();
    const { taken, placed } = await run(
      Effect.gen(function* () {
        const r = yield* repo;
        const taken = yield* r.take({ ...seatA, signalId: id, kind: "blocked", text: "remote", createdAt: 1, raises: true, threadId: thread });
        yield* r.take({ ...seatA, signalId: later, kind: "feedback", text: "remote plain", createdAt: 2, raises: true });
        const placed = yield* r.take({ ...seatA, signalId: later, kind: "feedback", text: "remote plain", createdAt: 2, raises: true, threadId: thread });
        return { taken, placed };
      }),
    );
    expect(taken?.threadId).toBe(thread);
    expect(placed?.threadId).toBe(thread);
  });
});

describe("a signal that comes after others", () => {
  it("keeps what it comes after in order, and finds what waits on a signal", async () => {
    const { a, b, c, waitingOnA, waitingOnAAfter } = await run(
      Effect.gen(function* () {
        const r = yield* repo;
        const a = yield* r.raise({ ...seatA, kind: "feedback", text: "first" });
        const b = yield* r.raise({ ...seatA, kind: "feedback", text: "second", dependsOn: [a.signalId] });
        const c = yield* r.raise({ ...seatA, kind: "feedback", text: "third", dependsOn: [b.signalId, a.signalId, b.signalId] });
        const waitingOnA = yield* r.listWaitingOn(a.signalId);
        yield* r.withdraw(seatA, b.signalId);
        return { a, b, c, waitingOnA, waitingOnAAfter: yield* r.listWaitingOn(a.signalId) };
      }),
    );
    expect(a).not.toHaveProperty("dependsOn");
    expect(b.dependsOn).toEqual([a.signalId]);
    expect(c.dependsOn).toEqual([b.signalId, a.signalId]);
    expect(waitingOnA.map((signal) => signal.signalId)).toEqual([b.signalId, c.signalId]);
    // Only open signals wait.
    expect(waitingOnAAfter.map((signal) => signal.signalId)).toEqual([c.signalId]);
  });

  it("comes after only its own seat's signals that exist", async () => {
    const { foreign, missing } = await run(
      Effect.gen(function* () {
        const r = yield* repo;
        const theirs = yield* r.raise({ ...seatB, kind: "feedback", text: "b's" });
        const foreign = yield* r.raise({ ...seatA, kind: "feedback", text: "after b", dependsOn: [theirs.signalId] }).pipe(Effect.flip);
        const missing = yield* r.raise({ ...seatA, kind: "feedback", text: "after none", dependsOn: [ulid()] }).pipe(Effect.flip);
        return { foreign, missing };
      }),
    );
    expect(foreign._tag).toBe("AgentSignalNotFound");
    expect(missing._tag).toBe("AgentSignalNotFound");
    expect(await run(Effect.flatMap(repo, (r) => r.listSeat(seatA)))).toEqual([]);
  });

  it("never comes after a signal an automation raised on the seat, and writes nothing", async () => {
    const { refused, held } = await run(
      Effect.gen(function* () {
        const r = yield* repo;
        const automations = yield* r.raise({
          ...seatA,
          kind: "notice",
          text: "the nightly run finished",
          source: { kind: "automation", automationId: ulid(), nodeId: seatA.nodeId },
        });
        const refused = yield* r.raise({ ...seatA, kind: "feedback", text: "after the run", dependsOn: [automations.signalId] }).pipe(Effect.flip);
        return { refused, held: yield* r.listSeat(seatA) };
      }),
    );
    expect(refused._tag).toBe("AgentSignalNotFound");
    expect(held.map((signal) => signal.text)).toEqual(["the nightly run finished"]);
  });

  it(`comes after at most ${AGENT_SIGNAL_MAX_DEPENDS_ON}, in the store too`, async () => {
    const { eight, nine } = await run(
      Effect.gen(function* () {
        const r = yield* repo;
        const ids: Array<string> = [];
        for (let n = 0; n <= AGENT_SIGNAL_MAX_DEPENDS_ON; n += 1) {
          ids.push((yield* r.raise({ ...seatA, kind: "feedback", text: `batch ${n}` })).signalId);
        }
        const eight = yield* r.raise({ ...seatA, kind: "feedback", text: "after eight", dependsOn: ids.slice(0, AGENT_SIGNAL_MAX_DEPENDS_ON) });
        const nine = yield* r.raise({ ...seatA, kind: "feedback", text: "after nine", dependsOn: ids }).pipe(Effect.flip);
        return { eight, nine };
      }),
    );
    expect(eight.dependsOn).toHaveLength(AGENT_SIGNAL_MAX_DEPENDS_ON);
    expect(nine._tag).toBe("AgentSignalPersistenceError");
  });

  it(`refuses to take another machine's signal past ${AGENT_SIGNAL_MAX_DEPENDS_ON}, and drops a self-reference`, async () => {
    const { refused, held, selfNamed } = await run(
      Effect.gen(function* () {
        const r = yield* repo;
        const named = Array.from({ length: AGENT_SIGNAL_MAX_DEPENDS_ON + 1 }, () => ulid());
        const id = ulid();
        const refused = yield* r.take({ ...seatA, signalId: id, kind: "feedback", text: "nine", createdAt: 1, raises: true, dependsOn: named }).pipe(Effect.flip);
        const held = yield* r.listSeat(seatA);
        const self = ulid();
        const selfNamed = yield* r.take({
          ...seatA,
          signalId: self,
          kind: "feedback",
          text: "eight and itself",
          createdAt: 2,
          raises: true,
          dependsOn: [self, ...named.slice(0, AGENT_SIGNAL_MAX_DEPENDS_ON)],
        });
        return { refused, held, selfNamed };
      }),
    );
    expect(refused._tag).toBe("AgentSignalPersistenceError");
    expect(held).toEqual([]);
    expect(selfNamed?.dependsOn).toHaveLength(AGENT_SIGNAL_MAX_DEPENDS_ON);
    expect(selfNamed?.dependsOn).not.toContain(selfNamed?.signalId);
  });

  it("reads a seat's newest signal, for a batch raised in order", async () => {
    const { none, newest, last } = await run(
      Effect.gen(function* () {
        const r = yield* repo;
        const none = yield* r.latestSeat(seatA);
        yield* r.raise({ ...seatA, kind: "feedback", text: "one" });
        const last = yield* r.raise({ ...seatA, kind: "feedback", text: "two" });
        yield* r.dismiss(last.signalId);
        yield* r.raise({ ...seatB, kind: "feedback", text: "b's" });
        return { none, newest: yield* r.latestSeat(seatA), last };
      }),
    );
    expect(none).toBeUndefined();
    expect(newest?.signalId).toBe(last.signalId);
  });
});

describe("a signal is announced once its write commits", () => {
  it("announces nothing from an outer transaction that rolls back", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const r = yield* repo;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* r.raise({ ...seatA, kind: "feedback", text: "one" });
            yield* r.raise({ ...seatA, kind: "feedback", text: "two" });
            return yield* r.raise({ ...seatA, kind: "feedback", text: "three", dependsOn: [ulid()] });
          }),
        ).pipe(Effect.flip);
      }),
    );
    expect(outcome._tag).toBe("AgentSignalNotFound");
    expect(heard).toEqual([]);
    expect(await run(Effect.flatMap(repo, (r) => r.listSeat(seatA)))).toEqual([]);
  });

  it("announces each signal once, after the outer commit", async () => {
    const heardInside: Array<number> = [];
    const raised = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const r = yield* repo;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const one = yield* r.raise({ ...seatA, kind: "feedback", text: "one" });
            const two = yield* r.raise({ ...seatA, kind: "feedback", text: "two", dependsOn: [one.signalId] });
            heardInside.push(heard.length);
            return [one, two];
          }),
        );
      }),
    );
    expect(heardInside).toEqual([0]);
    expect(heard.map((signal) => signal.signalId)).toEqual(raised.map((signal) => signal.signalId));
  });

  it("announces at once with no outer transaction, as before", async () => {
    await run(
      Effect.gen(function* () {
        const r = yield* repo;
        const one = yield* r.raise({ ...seatA, kind: "feedback", text: "one" });
        expect(heard.map((signal) => signal.signalId)).toEqual([one.signalId]);
        yield* r.answer(one.signalId, "ok");
        expect(heard.map((signal) => signal.state)).toEqual(["open", "answered"]);
      }),
    );
  });
});
