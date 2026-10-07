import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import {
  AGENT_SIGNAL_CLOSED_HISTORY,
  AgentSignalRepository,
  AgentSignalRepositoryLive,
} from "../src/main/junto/signals/repository";

let root: string;
let runtime: ManagedRuntime.ManagedRuntime<AgentSignalRepository, unknown>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-signals-"));
  runtime = ManagedRuntime.make(
    AgentSignalRepositoryLive.pipe(
      Layer.provide(makeStateEngineLive(join(root, "junto.db"))),
    ),
  );
});

afterEach(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const run = <A, E>(effect: Effect.Effect<A, E, AgentSignalRepository>) =>
  runtime.runPromise(effect);
const repo = AgentSignalRepository;
const seatA = { canvasName: "factory", nodeId: "agent-a" };
const seatB = { canvasName: "factory", nodeId: "agent-b" };

describe("AgentSignalRepository", () => {
  it("raises an open signal on the caller's seat", async () => {
    const signal = await run(
      Effect.gen(function* () {
        const r = yield* repo;
        return yield* r.raise({ ...seatA, kind: "blocked", text: "need the API key", detail: "## why" });
      }),
    );
    expect(signal).toMatchObject({
      ...seatA,
      kind: "blocked",
      text: "need the API key",
      detail: "## why",
      state: "open",
    });
    expect(signal.closedAt).toBeUndefined();
  });

  it("answers once, recording the response, and refuses a second close", async () => {
    const answered = await run(
      Effect.gen(function* () {
        const r = yield* repo;
        const s = yield* r.raise({ ...seatA, kind: "escalate", text: "pick a db" });
        return yield* r.answer(s.signalId, "use sqlite");
      }),
    );
    expect(answered.state).toBe("answered");
    expect(answered.response?.text).toBe("use sqlite");
    const again = await run(
      Effect.gen(function* () {
        const r = yield* repo;
        return yield* Effect.flip(r.dismiss(answered.signalId));
      }),
    );
    expect(again._tag).toBe("AgentSignalNotFound");
  });

  it("lets a seat withdraw only its own open signals", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const r = yield* repo;
        const mine = yield* r.raise({ ...seatA, kind: "feedback", text: "review me" });
        const theirs = yield* r.raise({ ...seatB, kind: "blocked", text: "stuck" });
        const foreign = yield* Effect.flip(r.withdraw(seatA, theirs.signalId));
        const own = yield* r.withdraw(seatA, mine.signalId);
        const still = yield* r.get(theirs.signalId);
        return { foreign, own, still };
      }),
    );
    expect(outcome.foreign._tag).toBe("AgentSignalNotFound");
    expect(outcome.own.map((s) => s.state)).toEqual(["withdrawn"]);
    expect(outcome.still.state).toBe("open");
  });

  it("withdraws every open signal of the seat when no id is given", async () => {
    const withdrawn = await run(
      Effect.gen(function* () {
        const r = yield* repo;
        yield* r.raise({ ...seatA, kind: "feedback", text: "one" });
        yield* r.raise({ ...seatA, kind: "escalate", text: "two" });
        yield* r.raise({ ...seatB, kind: "escalate", text: "other seat" });
        yield* r.withdraw(seatA);
        return yield* r.listCanvas("factory");
      }),
    );
    expect(
      withdrawn.map((s) => `${s.nodeId}:${s.state}`).sort(),
    ).toEqual(["agent-a:withdrawn", "agent-a:withdrawn", "agent-b:open"]);
  });

  it("lists open signals first and bounds closed history per seat", async () => {
    const listed = await run(
      Effect.gen(function* () {
        const r = yield* repo;
        for (let i = 0; i < AGENT_SIGNAL_CLOSED_HISTORY + 3; i += 1) {
          const s = yield* r.raise({ ...seatA, kind: "feedback", text: `old ${i}` });
          yield* r.dismiss(s.signalId);
        }
        yield* r.raise({ ...seatA, kind: "blocked", text: "now" });
        return yield* r.listSeat(seatA);
      }),
    );
    expect(listed[0]?.text).toBe("now");
    expect(listed.filter((s) => s.state !== "open")).toHaveLength(
      AGENT_SIGNAL_CLOSED_HISTORY,
    );
  });

  it("keeps a signal's attachments in order, with captions, across every read", async () => {
    const ref = (name: string, fill: string) =>
      ({ sha256: fill.repeat(64), byteLength: 10, mediaType: "image/png", displayName: name }) as never;
    const attachments = [
      { ref: ref("before.png", "a"), caption: "Before" },
      { ref: ref("after.png", "b") },
    ];
    const { raised, got, listed, plain } = await run(
      Effect.gen(function* () {
        const r = yield* repo;
        const raised = yield* r.raise({ ...seatA, kind: "feedback", text: "ready", signalId: "sig-with-files", attachments });
        const plain = yield* r.raise({ ...seatA, kind: "feedback", text: "no files" });
        return {
          raised,
          plain,
          got: yield* r.get("sig-with-files"),
          listed: yield* r.listCanvas("factory"),
        };
      }),
    );
    expect(raised.signalId).toBe("sig-with-files");
    expect(raised.attachments).toEqual(attachments);
    expect(got.attachments).toEqual(attachments);
    expect(listed.find((signal) => signal.signalId === "sig-with-files")?.attachments).toEqual(attachments);
    // No files, no field.
    expect(plain).not.toHaveProperty("attachments");
    expect(listed.find((signal) => signal.signalId === plain.signalId)).not.toHaveProperty("attachments");
  });

  it("holds any number of attachments and a caption of any length", async () => {
    const attachments = Array.from({ length: 200 }, (_, n) => ({
      ref: { sha256: n.toString(16).padStart(64, "0"), byteLength: n, mediaType: "text/plain", displayName: `${n}.txt` } as never,
      caption: n === 0 ? "x".repeat(5000) : `file ${n}`,
    }));
    const got = await run(
      Effect.gen(function* () {
        const r = yield* repo;
        yield* r.raise({ ...seatA, kind: "feedback", text: "many", signalId: "sig-many", attachments });
        return yield* r.get("sig-many");
      }),
    );
    expect(got.attachments).toHaveLength(200);
    expect(got.attachments).toEqual(attachments);
  });
});
