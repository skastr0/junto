import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Schema } from "effect";
import { expect, it, vi } from "vitest";
import { startCore } from "../src/main/junto/core";
import { ModelService } from "../src/main/junto/model/service";
import { MachineRepository } from "../src/main/junto/machines/repository";
import { SeatSessionRepository } from "../src/main/junto/seat-sessions/repository";
import { announceSeatOffboard } from "../src/main/junto/seat-sessions/service";
import { coldSessionStartsFresh, seatOffboardStatus } from "../src/main/junto/seat-sessions/operator-offboard";
import { Command } from "../src/shared/model";

it("a windowless core closes a session on the agent's own offboard, and answers the cut", async () => {
  const home = await mkdtemp(join(tmpdir(), "junto-core-sessions-"));
  let core: Awaited<ReturnType<typeof startCore>> | undefined;
  try {
    core = await startCore({ home, build: "b".repeat(64), bundles: {} });
    const run = core.runtime.runPromise;
    const machineName = await run(Effect.flatMap(MachineRepository, (machines) => machines.machineName));
    const command = Schema.decodeUnknownSync(Command);
    await run(Effect.flatMap(ModelService, (model) => model.command(command({ _tag: "CreateCanvas", canvas: "rest" }), "operator")));
    await run(Effect.flatMap(ModelService, (model) => model.command(command({ _tag: "Add", canvas: "rest", nodes: [{
      kind: "agent", id: "own-seat", x: 0, y: 0, width: 200, height: 100, z: 0,
      label: "Own", agentKey: "local:own", bindingId: "own-binding", host: machineName,
      harness: "codex", overseer: false,
    }], wires: [] }), "operator")));
    await run(Effect.flatMap(SeatSessionRepository, (sessions) =>
      sessions.record({ seatId: "own-seat", bindingId: "own-binding", sessionId: "session-one", harness: "codex" })));
    const current = () => run(Effect.flatMap(SeatSessionRepository, (sessions) => sessions.current("own-seat", "own-binding")));
    expect((await current())?.sessionId).toBe("session-one");
    // The card's own read: the open session on the binding the seat holds
    // now, never the seat's history, and no open one on an old binding.
    const launch = (bindingId = "own-binding") =>
      run(Effect.flatMap(SeatSessionRepository, (sessions) => sessions.launch("own-seat", bindingId)));
    expect(await launch()).toEqual({
      open: { seatId: "own-seat", sessionId: "session-one", harness: "codex", bindingId: "own-binding" },
    });
    expect(await launch("an-older-binding")).toEqual({});

    // Operator offboard is installed: a resting seat on this machine may be closed now.
    const [status] = await seatOffboardStatus("rest", ["own-seat"]);
    expect(status?.now).toEqual({ allowed: true });
    // The start decision answers too: a session that has done no work resumes.
    expect(await coldSessionStartsFresh({ canvasName: "rest", seatId: "own-seat" }, "mail")).toBe(false);

    // The agent's own `junto offboard` was answered: the closer ends the session.
    announceSeatOffboard({ seatId: "own-seat", canvasName: "rest", sessionId: "session-one", at: Date.now(), mode: "rest" });
    await vi.waitFor(async () => {
      expect((await current())?.sessionId).not.toBe("session-one");
    }, { timeout: 5_000 });
    const sessions = await run(Effect.flatMap(SeatSessionRepository, (repository) => repository.list("own-seat")));
    expect(sessions.find((session) => session.sessionId === "session-one")?.endedAt).toBeTypeOf("number");
    // With the session ended, the same read names no open one and why it ended:
    // what the next start reads to answer offboarded or fresh.
    expect(await launch()).toEqual({ lastEnded: "offboard" });
  } finally {
    await core?.close();
    await rm(home, { recursive: true, force: true });
  }
});
