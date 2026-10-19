import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Schema } from "effect";
import { expect, it } from "vitest";
import { startCore } from "../src/main/junto/core";
import { ModelService } from "../src/main/junto/model/service";
import { MachineRepository } from "../src/main/junto/machines/repository";
import { SeatSessionRepository } from "../src/main/junto/seat-sessions/repository";
import { setOperatorOffboard, type OperatorOffboard } from "../src/main/junto/seat-sessions/operator-offboard";
import { ensureSeatSessionId } from "../src/main/junto/term/seat-session-before-start";
import { Command } from "../src/shared/model";

it("a windowless core's start asks the start decision, with why it starts: a cold session starts fresh, a warm one resumes", async () => {
  const home = await mkdtemp(join(tmpdir(), "junto-core-start-"));
  let core: Awaited<ReturnType<typeof startCore>> | undefined;
  try {
    core = await startCore({ home, build: "b".repeat(64), bundles: {} });
    const run = core.runtime.runPromise;
    const machineName = await run(Effect.flatMap(MachineRepository, (machines) => machines.machineName));
    const command = Schema.decodeUnknownSync(Command);
    await run(Effect.flatMap(ModelService, (model) => model.command(command({ _tag: "CreateCanvas", canvas: "rest" }), "operator")));
    const agent = (id: string, harness: string) => ({
      kind: "agent", id, x: 0, y: 0, width: 200, height: 100, z: 0, label: id, agentKey: `local:${id}`,
      bindingId: `${id}-binding`, host: machineName, harness, overseer: false, onRemove: "detach",
    });
    await run(Effect.flatMap(ModelService, (model) => model.command(command({ _tag: "Add", canvas: "rest",
      nodes: [agent("pinned", "claude"), agent("captured", "codex")], wires: [] }), "operator")));
    for (const [seatId, harness] of [["pinned", "claude"], ["captured", "codex"]] as const) {
      await run(Effect.flatMap(SeatSessionRepository, (sessions) =>
        sessions.record({ seatId, bindingId: `${seatId}-binding`, sessionId: `${seatId}-one`, harness })));
    }

    let cold = false;
    const asked: string[] = [];
    const ended: string[] = [];
    // As hybrid decides: mail starts a cold seat fresh, the operator's open continues it.
    setOperatorOffboard({
      coldAtStart: async (seat: { readonly seatId: string }, cause: string) => {
        asked.push(`${seat.seatId}/${cause}`);
        return cold && cause !== "operator";
      },
      endedAtStart: (seat: { readonly seatId: string }, _binding: string, sessionId: string) => {
        ended.push(`${seat.seatId}/${sessionId}`);
      },
    } as unknown as OperatorOffboard);
    const start = (seatId: string, harness: string, cause?: "operator" | "mail") =>
      ensureSeatSessionId({
        canvasName: "rest", nodeId: seatId, bindingId: `${seatId}-binding`, harness, ...(cause ? { cause } : { cause: "mail" as const }),
      });

    // Warm: both resume the session they have.
    expect(await start("pinned", "claude")).toMatchObject({ ok: true, sessionId: "pinned-one" });
    expect(await start("captured", "codex")).toMatchObject({ ok: true, sessionId: "captured-one" });
    expect(ended).toEqual([]);

    // Cold: a pinned harness gets a new id; a captured one starts with none and names its own.
    cold = true;
    const pinned = await start("pinned", "claude");
    expect(pinned).toMatchObject({ ok: true, minted: true });
    expect(pinned.ok && pinned.sessionId).not.toBe("pinned-one");
    expect(await start("captured", "codex")).toMatchObject({ ok: true, sessionId: "" });
    expect(ended).toEqual(["pinned/pinned-one", "captured/captured-one"]);
    expect(asked).toEqual(["pinned/mail", "captured/mail", "pinned/mail", "captured/mail"]);
    const list = await run(Effect.flatMap(SeatSessionRepository, (sessions) => sessions.list("captured")));
    expect(list.find((session) => session.sessionId === "captured-one")?.endedAt).toBeTypeOf("number");

    // The operator opening it, cold still: the cause reaches the decision, and it resumes.
    asked.length = 0;
    expect(await start("pinned", "claude", "operator")).toMatchObject({ ok: true, sessionId: pinned.ok ? pinned.sessionId : "" });
    // A start that names no cause is the operator's.
    await ensureSeatSessionId({ canvasName: "rest", nodeId: "pinned", bindingId: "pinned-binding", harness: "claude" });
    expect(asked).toEqual(["pinned/operator", "pinned/operator"]);
    expect(ended).toHaveLength(2);

    // The operator's own fresh start does not ask: it is fresh already.
    asked.length = 0;
    await ensureSeatSessionId({ canvasName: "rest", nodeId: "pinned", bindingId: "pinned-binding", harness: "claude", fresh: true });
    expect(asked).toEqual([]);
  } finally {
    setOperatorOffboard(undefined);
    await core?.close();
    await rm(home, { recursive: true, force: true });
  }
});
