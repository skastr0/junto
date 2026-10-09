import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Layer, ManagedRuntime, Schema } from "effect";
import { expect, it, vi } from "vitest";
import { createSandbox, destroySandbox, writeFixtureModel } from "../e2e/harness/sandbox";
import { modelFixture, modelSeat } from "../e2e/harness/model";
import { ModelService } from "../src/main/junto/model/service";
import { ModelDependents } from "../src/main/junto/model/dependents";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { StationRepositoryLive } from "../src/main/junto/station/repository";
import { Command } from "../src/shared/model";

const app = vi.hoisted(() => ({ runPromise: vi.fn() }));
vi.mock("../src/main/core-runner", () => ({ coreRunner: app }));
import { SeatSessionCapture } from "../src/main/junto/term/seat-session-capture";

it("captures a Codex rollout after offboard and records its id through the runtime command into SQLite", async () => {
  const sandbox = await createSandbox();
  const sessionId = "01a0e983-fee2-7ff2-97db-b10259aa4d84";
  try {
    const seat = modelSeat({ id: "seat", key: "local:seat", label: "Seat", cwd: sandbox.root, sessionId: "first-session" });
    await writeFixtureModel(sandbox, "proof", modelFixture([seat]));
    const runtime = ManagedRuntime.make(Layer.provideMerge(Layer.provide(ModelService.layer, ModelDependents.empty), Layer.provideMerge(StationRepositoryLive, makeStateEngineLive(join(sandbox.homeDir, ".junto", "state", "junto.db")))));
    app.runPromise.mockImplementation((effect) => runtime.runPromise(effect));
    try {
      const model = await runtime.runPromise(ModelService);
      await runtime.runPromise(model.command(Schema.decodeUnknownSync(Command)({ _tag: "RecordSession", canvas: "proof", id: "seat", sessionId: null }), "runtime"));
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
      expect((await runtime.runPromise(model.open("proof"))).nodes[0]).toMatchObject({ sessionId });
      expect(capture.pending()).toEqual([]);
    } finally { app.runPromise.mockReset(); await runtime.dispose(); }
    const reopened = ManagedRuntime.make(Layer.provideMerge(Layer.provide(ModelService.layer, ModelDependents.empty), makeStateEngineLive(join(sandbox.homeDir, ".junto", "state", "junto.db"))));
    try {
      const model = await reopened.runPromise(ModelService);
      expect((await reopened.runPromise(model.open("proof"))).nodes[0]).toMatchObject({ sessionId });
    } finally { await reopened.dispose(); }
  } finally { await destroySandbox(sandbox); }
});
