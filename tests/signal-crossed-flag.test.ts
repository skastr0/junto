/**
 * An answer and a withdrawal that crossed read as `crossed` on the signal the
 * window holds, as either machine keeps them, so an older thread page can say
 * "<seat> withdrew this before your answer reached it" with no reread.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSignal } from "../src/shared/wire/agent-signals";
import { crossedClosing } from "../src/shared/signal-crossing";
import { makeStateEngineLive } from "../src/core/state/engine";
import { AgentSignalRepository, AgentSignalRepositoryLive } from "../src/core/signals/repository";

let root: string;
let runtime: ManagedRuntime.ManagedRuntime<AgentSignalRepository | SqlClient.SqlClient, unknown>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-signal-crossed-"));
  runtime = ManagedRuntime.make(Layer.provideMerge(AgentSignalRepositoryLive, makeStateEngineLive(join(root, "junto.db"))));
});

afterEach(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const seat = { canvasName: "factory", nodeId: "agent-a" };

const read = (signalId: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const repo = yield* AgentSignalRepository;
      const listed = yield* repo.listSeat(seat);
      return listed.find((signal) => signal.signalId === signalId)!;
    }),
  );

describe("crossed on the signal", () => {
  it("is set on an answered signal that holds a withdrawal beside it, as the editing machine keeps it", async () => {
    const signal = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* AgentSignalRepository;
        const sql = yield* SqlClient.SqlClient;
        const raised = yield* repo.raise({ ...seat, kind: "escalate", text: "pick one" });
        yield* repo.answer(raised.signalId, "go");
        yield* sql`UPDATE agent_signals SET withdrawn_at = 99 WHERE signal_id = ${raised.signalId}`;
        return raised;
      }),
    );
    const held = await read(signal.signalId);
    expect(held).toMatchObject({ state: "answered", crossed: true });
    expect(crossedClosing(held)).toBe(true);
  });

  it("is set on a withdrawn signal that holds the answer that came after, as the seat's machine keeps it", async () => {
    const signal = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* AgentSignalRepository;
        const sql = yield* SqlClient.SqlClient;
        const raised = yield* repo.raise({ ...seat, kind: "escalate", text: "pick one" });
        yield* repo.withdraw(seat, raised.signalId);
        yield* sql`UPDATE agent_signals SET response_text = 'go', response_at = 99 WHERE signal_id = ${raised.signalId}`;
        return raised;
      }),
    );
    const held = await read(signal.signalId);
    expect(held).toMatchObject({ state: "withdrawn", crossed: true });
    expect(crossedClosing(held)).toBe(true);
  });

  it("is absent on an open, a plainly answered, a plainly withdrawn and a dismissed signal", async () => {
    const ids = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* AgentSignalRepository;
        const open = yield* repo.raise({ ...seat, kind: "escalate", text: "open" });
        const answered = yield* repo.raise({ ...seat, kind: "escalate", text: "answered" });
        yield* repo.answer(answered.signalId, "go");
        const withdrawn = yield* repo.raise({ ...seat, kind: "escalate", text: "withdrawn" });
        yield* repo.withdraw(seat, withdrawn.signalId);
        const dismissed = yield* repo.raise({ ...seat, kind: "feedback", text: "dismissed" });
        yield* repo.dismiss(dismissed.signalId);
        return [open, answered, withdrawn, dismissed].map((signal) => signal.signalId);
      }),
    );
    for (const id of ids) {
      const held = await read(id);
      expect(held).not.toHaveProperty("crossed");
      expect(crossedClosing(held)).toBe(false);
    }
  });

  it("crosses the window wire under a strict encode", async () => {
    const signal = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* AgentSignalRepository;
        const sql = yield* SqlClient.SqlClient;
        const raised = yield* repo.raise({ ...seat, kind: "escalate", text: "pick one" });
        yield* repo.answer(raised.signalId, "go");
        yield* sql`UPDATE agent_signals SET withdrawn_at = 99 WHERE signal_id = ${raised.signalId}`;
        return raised;
      }),
    );
    const held = await read(signal.signalId);
    expect(Schema.encodeUnknownSync(AgentSignal)(held, { onExcessProperty: "error" })).toMatchObject({ crossed: true });
  });
});
