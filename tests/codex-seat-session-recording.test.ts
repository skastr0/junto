import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { expect, it, vi } from "vitest";
import { createSandbox, destroySandbox, writeFixtureModel } from "../e2e/harness/sandbox";
import { modelFixture, modelSeat } from "../e2e/harness/model";
import { ModelService } from "../src/main/junto/model/service";
import { ModelDependents } from "../src/main/junto/model/dependents";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import { makeSeatSessionRepositoryLive, SeatSessionRepository } from "../src/main/junto/seat-sessions/repository";
import { THIS_MACHINE } from "./support/machines";

const app = vi.hoisted(() => ({ runPromise: vi.fn() }));
vi.mock("../src/main/core-runner", () => ({ coreRunner: app }));
import { SeatSessionCapture } from "../src/main/junto/term/seat-session-capture";

it("captures a Codex rollout into the machine's private pin without changing the canvas", async () => {
  const sandbox = await createSandbox();
  const sessionId = "01a0e983-fee2-7ff2-97db-b10259aa4d84";
  try {
    const seat = modelSeat({ id: "seat", key: "local:seat", label: "Seat", cwd: sandbox.root });
    await writeFixtureModel(sandbox, "proof", modelFixture([seat]));
    const makeRuntime = () => ManagedRuntime.make(Layer.provideMerge(
      Layer.provide(ModelService.layer, ModelDependents.empty),
      Layer.provideMerge(Layer.mergeAll(
        makeMachineRepositoryLive({ defaultName: () => THIS_MACHINE }),
        makeSeatSessionRepositoryLive(join(sandbox.homeDir, ".junto", "seats")),
      ), makeStateEngineLive(join(sandbox.homeDir, ".junto", "state", "junto.db"))),
    ));
    const runtime = makeRuntime();
    app.runPromise.mockImplementation((effect) => runtime.runPromise(effect));
    try {
      const model = await runtime.runPromise(ModelService);
      const before = await runtime.runPromise(model.open("proof"));
      const capture = new SeatSessionCapture(() => sandbox.homeDir);
      capture.watch({ bindingId: seat.bindingId, harness: "codex", canvasName: "proof", nodeId: seat.id, cwd: sandbox.root, spawnedAtMs: Date.now(), excludeSessionIds: ["first-session"] });
      expect(await capture.attempt(seat.bindingId)).toBeUndefined();
      const at = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const dir = join(sandbox.homeDir, ".codex", "sessions", String(at.getFullYear()), pad(at.getMonth() + 1), pad(at.getDate()));
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `rollout-${at.getTime()}-${sessionId}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, timestamp: at.toISOString(), cwd: sandbox.root, source: "cli", thread_source: "user" } })}\n`);
      // Files alone do not call capture. A runtime boundary has to attempt it.
      expect((await runtime.runPromise(model.open("proof"))).nodes[0]).not.toHaveProperty("sessionId");
      expect(await capture.attempt(seat.bindingId)).toBe(sessionId);
      expect(await runtime.runPromise(Effect.flatMap(SeatSessionRepository, repo => repo.current(seat.id, seat.bindingId)))).toMatchObject({ sessionId });
      expect(await runtime.runPromise(model.open("proof"))).toEqual(before);
      expect(capture.pending()).toEqual([]);
    } finally { app.runPromise.mockReset(); await runtime.dispose(); }
    const reopened = makeRuntime();
    try {
      const model = await reopened.runPromise(ModelService);
      expect((await reopened.runPromise(model.open("proof"))).nodes[0]).not.toHaveProperty("sessionId");
      expect(await reopened.runPromise(Effect.flatMap(SeatSessionRepository, repo => repo.current(seat.id, seat.bindingId)))).toMatchObject({ sessionId });
    } finally { await reopened.dispose(); }
  } finally { await destroySandbox(sandbox); }
});
