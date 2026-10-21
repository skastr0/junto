/**
 * A seat's answered signals by answer time, the read seat since takes for
 * silent answers: a signal raised long before and answered after the bound
 * is held, however many signals closed after it, which the capped listing
 * would drop.
 */
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
  root = await mkdtemp(join(tmpdir(), "junto-signals-answered-"));
  runtime = ManagedRuntime.make(AgentSignalRepositoryLive.pipe(Layer.provide(makeStateEngineLive(join(root, "junto.db")))));
});

afterEach(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const run = <A, E>(effect: Effect.Effect<A, E, AgentSignalRepository>) => runtime.runPromise(effect);
const seat = { canvasName: "factory", nodeId: "agent-a" };
const other = { canvasName: "factory", nodeId: "agent-b" };

describe("listSeatAnswered", () => {
  it("holds an answer the capped listing drops, bounded by answer time", async () => {
    const { early, before, after } = await run(
      Effect.gen(function* () {
        const r = yield* AgentSignalRepository;
        const early = yield* r.raise({ ...seat, kind: "escalate", text: "raised first" });
        const before = Date.now();
        yield* r.answer(early.signalId, "go ahead");
        const after = Date.now() + 1;
        // Later signals are raised in a later millisecond, so they rank above it.
        yield* Effect.sleep("5 millis");
        for (let n = 0; n <= AGENT_SIGNAL_CLOSED_HISTORY; n += 1) {
          const later = yield* r.raise({ ...seat, kind: "feedback", text: `later ${n}` });
          yield* r.dismiss(later.signalId);
        }
        const elsewhere = yield* r.raise({ ...other, kind: "escalate", text: "not this seat" });
        yield* r.answer(elsewhere.signalId, "no");
        return { early, before, after };
      }),
    );
    const listed = await run(Effect.flatMap(AgentSignalRepository, (r) => r.listSeat(seat)));
    expect(listed.some((signal) => signal.signalId === early.signalId)).toBe(false);

    const all = await run(Effect.flatMap(AgentSignalRepository, (r) => r.listSeatAnswered(seat)));
    expect(all.map((signal) => signal.signalId)).toEqual([early.signalId]);
    expect(all[0]?.response?.text).toBe("go ahead");

    const bounded = await run(Effect.flatMap(AgentSignalRepository, (r) => r.listSeatAnswered(seat, before)));
    expect(bounded.map((signal) => signal.signalId)).toEqual([early.signalId]);
    const past = await run(Effect.flatMap(AgentSignalRepository, (r) => r.listSeatAnswered(seat, after)));
    expect(past).toEqual([]);
  });
});
