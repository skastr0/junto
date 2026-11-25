/**
 * A deleted seat's open signals close with it, and a deleted canvas's close
 * with each of its seats, by one pass in the model delete's transaction: the
 * signal ends withdrawn, its record stays in history, its files are let go,
 * and each is announced once the delete commits. A live seat's signals are
 * never touched by it (remote-lead's terms 1, 2 and 4 for a seat's removal).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSignal } from "@shared/agent-signals";
import { asCanvasName, asNodeId } from "../src/shared/model";
import { makeStateEngineLive } from "../src/core/state/engine";
import { ModelLive } from "../src/core/model/layer";
import { ModelService } from "../src/core/model/service";
import { AgentSignalRepository, AgentSignalRepositoryLive } from "../src/core/signals/repository";
import { onAgentSignalChanged } from "../src/core/signals/changes";
import { ProductModelDependentsLive } from "../src/core/view-state/model-dependents";
import { CorePushes } from "../src/core/push";
import { seat } from "./support/model-nodes";
import { THIS_MACHINE } from "./support/machines";

const main = asCanvasName("main");
const other = asCanvasName("other");
const gone = asNodeId("gone");
const live = asNodeId("live");
const SHA = "a".repeat(64);

let dir: string;
let runtime: ReturnType<typeof machineAt>;

const machineAt = (root: string) => {
  const engine = Layer.merge(makeStateEngineLive(join(root, "junto.db")), CorePushes.nowhere);
  const model = Layer.provideMerge(ModelLive, Layer.provideMerge(ProductModelDependentsLive, engine));
  return ManagedRuntime.make(Layer.provideMerge(AgentSignalRepositoryLive, model));
};

const run = <A, E>(effect: Effect.Effect<A, E, ModelService | SqlClient.SqlClient | AgentSignalRepository>) =>
  runtime.runPromise(effect as never) as Promise<A>;

const raise = (canvasName: string, nodeId: string, text: string) =>
  Effect.flatMap(AgentSignalRepository, (signals) => signals.raise({ canvasName, nodeId, kind: "escalate", text }));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "junto-signals-delete-"));
  runtime = machineAt(dir);
  await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // The seats' machine is this one, as a configured install.
      yield* sql`INSERT INTO known_installations VALUES ('local-installation','2026-10-07')`;
      yield* sql`INSERT INTO installation VALUES (1,'local-installation','2026-10-07')`;
      yield* sql`INSERT INTO machine_configuration(singleton, machine_name, supervised_preferred, configured_at) VALUES (1, ${THIS_MACHINE}, 1, '2026-10-07')`;
      const model = yield* ModelService;
      for (const canvas of [main, other]) {
        yield* model.command({ _tag: "CreateCanvas", canvas }, "operator");
        yield* model.command({ _tag: "Add", canvas, nodes: [seat("gone"), seat("live")], wires: [] }, "operator");
      }
    }),
  );
});

afterEach(async () => {
  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

const stateOf = (signals: ReadonlyArray<AgentSignal>) => signals.map((signal) => [signal.text, signal.state]);

describe("a delete closes the open signals of what it removes", () => {
  it("closes a deleted seat's open signals, keeps the record and the files' release, announces each once, and leaves a live seat's alone", async () => {
    const heard: AgentSignal[] = [];
    const off = onAgentSignalChanged((signal) => heard.push(signal));
    try {
      const { first, answered } = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const signals = yield* AgentSignalRepository;
          const first = yield* raise(main, gone, "first");
          yield* raise(main, gone, "second");
          yield* raise(main, live, "live one");
          yield* raise(other, gone, "same node id, other canvas");
          const answered = yield* raise(main, gone, "already answered");
          yield* signals.answer(answered.signalId, "done");
          // The first signal holds a file under its own id.
          yield* sql`INSERT INTO content_objects (sha256, byte_length, created_at, verified_at) VALUES (${SHA}, 3, 'now', 'now')`;
          yield* sql`INSERT INTO content_refs (ref_id, sha256, byte_length, media_type, owner_kind, owner_canvas, owner_node, owner_record_id, created_at)
            VALUES ('ref-1', ${SHA}, 3, 'text/plain', 'signal', ${main}, ${gone}, ${first.signalId}, 'now')`;
          heard.length = 0;
          const model = yield* ModelService;
          yield* model.command({ _tag: "Remove", canvas: main, nodes: [gone], wires: [] }, "operator");
          return { first, answered };
        }),
      );

      const after = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const signals = yield* AgentSignalRepository;
          return {
            goneHistory: yield* signals.listSeat({ canvasName: main, nodeId: gone }),
            live: yield* signals.listSeat({ canvasName: main, nodeId: live }),
            elsewhere: yield* signals.listSeat({ canvasName: other, nodeId: gone }),
            refs: yield* sql`SELECT ref_id FROM content_refs WHERE owner_kind = 'signal'`,
          };
        }),
      );

      // The record stays, closed as withdrawn; the answered one is as it was.
      expect(stateOf(after.goneHistory).sort()).toEqual([
        ["already answered", "answered"],
        ["first", "withdrawn"],
        ["second", "withdrawn"],
      ]);
      expect(after.goneHistory.filter((signal) => signal.state === "withdrawn").every((signal) => signal.closedAt !== undefined)).toBe(true);
      // A live seat's signals, and the same node id on another canvas, are never closed by it.
      expect(stateOf(after.live)).toEqual([["live one", "open"]]);
      expect(stateOf(after.elsewhere)).toEqual([["same node id, other canvas", "open"]]);
      // Its file is let go.
      expect(after.refs).toEqual([]);
      // Each closed signal is announced once, and only the closed ones.
      expect(heard.map((signal) => [signal.text, signal.state]).sort()).toEqual([["first", "withdrawn"], ["second", "withdrawn"]]);
      expect(first.signalId).not.toBe(answered.signalId);
    } finally {
      off();
    }
  });

  it("announces nothing when the delete rolls back, and closes nothing", async () => {
    const heard: AgentSignal[] = [];
    const off = onAgentSignalChanged((signal) => heard.push(signal));
    try {
      await run(raise(main, gone, "stays open"));
      heard.length = 0;
      await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const model = yield* ModelService;
          yield* sql.withTransaction(
            Effect.flatMap(
              model.command({ _tag: "Remove", canvas: main, nodes: [gone], wires: [] }, "operator"),
              () => Effect.fail("abort"),
            ),
          ).pipe(Effect.result);
        }),
      );
      const listed = await run(Effect.flatMap(AgentSignalRepository, (signals) => signals.listSeat({ canvasName: main, nodeId: gone })));
      expect(stateOf(listed)).toEqual([["stays open", "open"]]);
      expect(heard).toEqual([]);
    } finally {
      off();
    }
  });

  it("closes every open signal of a deleted canvas, each seat's by the same pass, and no other canvas's", async () => {
    await run(
      Effect.gen(function* () {
        yield* raise(main, gone, "g");
        yield* raise(main, live, "l");
        yield* raise(other, live, "elsewhere");
        const model = yield* ModelService;
        yield* model.command({ _tag: "RemoveCanvas", canvas: main }, "operator");
      }),
    );
    const read = await run(
      Effect.gen(function* () {
        const signals = yield* AgentSignalRepository;
        return {
          main: [...(yield* signals.listSeat({ canvasName: main, nodeId: gone })), ...(yield* signals.listSeat({ canvasName: main, nodeId: live }))],
          other: yield* signals.listSeat({ canvasName: other, nodeId: live }),
        };
      }),
    );
    expect(stateOf(read.main).sort()).toEqual([["g", "withdrawn"], ["l", "withdrawn"]]);
    expect(stateOf(read.other)).toEqual([["elsewhere", "open"]]);
  });
});
