import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import type { AgentSeatStateEvent } from "../src/shared/agent-seat-state";
import { ActorRef } from "../src/shared/work-protocol";
import { WorkRepository, WorkRepositoryLive } from "../src/main/junto/work/repository";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { makeSeatObservation } from "../src/main/junto/work/seat-observation";
import { seedCanvasRows } from "./support/seed-canvas";
import { canvasOf, seat, wire } from "./support/model-nodes";

it("a mailbox commit wakes a seat waiter once even when it immediately subscribes again", async () => {
  const root = await mkdtemp(join(tmpdir(), "junto-mail-waiter-"));
  const runtime = ManagedRuntime.make(Layer.provideMerge(WorkRepositoryLive, makeStateEngineLive(join(root, "junto.db"))));
  const abort = new AbortController();
  try {
    const sql = await runtime.runPromise(SqlClient.SqlClient);
    const repository = await runtime.runPromise(WorkRepository);
    const nodes = [seat("caller"), seat("peer")];
    const wires = [wire("mail", "caller", "peer", "messages")];
    const canvas = { ...canvasOf(nodes, wires, "mail-wait-reentrancy"), seq: 1 };
    await runtime.runPromise(sql.withTransaction(Effect.gen(function* () {
      yield* sql`INSERT INTO station_known_installations VALUES ('mail-home','2026-10-07')`;
      yield* sql`INSERT INTO station_installation VALUES (1,'mail-home','2026-10-07')`;
      yield* sql`INSERT INTO station_configuration(singleton,role,host_id,agent_host_id,command_center_installation_id,supervised_preferred,configured_at) VALUES (1,'command-center','local',NULL,NULL,1,'2026-10-07')`;
      yield* seedCanvasRows({ seq: 1, canvases: new Map([[canvas.name, { nodes, wires }]]) });
    })));
    const seatListeners = new Set<(event: AgentSeatStateEvent) => void>();
    let registrations = 0;
    let callbacks = 0;
    const observation = makeSeatObservation({
      readTask: () => Effect.succeed(undefined), readTopology: () => Effect.succeed(canvas),
      // Exercise the publisher with a synchronously re-subscribing consumer.
      // No facade or window invalidation forwards this mailbox notification.
      subscribeCanvasChanges: (listener) => {
        registrations += 1;
        const off = repository.subscribeChanges((changed) => {
          if (changed !== canvas.name) return;
          callbacks += 1;
          if (callbacks > 10) { off(); return; }
          listener(changed);
        });
        return off;
      },
      seatStates: { current: () => [], subscribe: (listener) => {
        seatListeners.add(listener); return () => { seatListeners.delete(listener); };
      } },
      subscribeWorkChanges: () => () => {}, sessionOf: () => ({ epoch: "e1", status: "running" }),
      readGrid: async () => undefined, subscribeGrid: () => () => {},
    });
    const flight = runtime.runPromiseExit(observation.waitSeat({ target: "peer", until: "idle", timeoutMs: 1_000 },
      { canvasName: canvas.name, nodeId: "caller" }), { signal: abort.signal });
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(registrations).toBe(1);
      await runtime.runPromise(repository.appendMessage({ sink: { canvasName: canvas.name, nodeId: "peer" },
        basis: { kind: "canvas", canvasName: canvas.name, seq: 1 },
        sentBy: Schema.decodeUnknownSync(ActorRef)({ seatId: `seat_${"a".repeat(64)}`, canvasName: canvas.name, nodeId: "caller" }),
        destination: { kind: "mailbox" }, message: { messageId: "mail", role: "user", parts: [{ kind: "text", text: "Hello" }] },
      }));
      expect(callbacks).toBe(1);
      expect(registrations).toBe(2);
      for (const listener of [...seatListeners]) listener({ bindingId: "binding-peer", epoch: "e1", state: "idle", reason: "settled",
        confidence: "high", at: Date.now() });
      expect((await flight)._tag).toBe("Success");
      expect(seatListeners.size).toBe(0);
    } finally { abort.abort(); await flight; }
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
});
