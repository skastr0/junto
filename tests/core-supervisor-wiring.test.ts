/**
 * The core boots the injection supervisor's writers. Nothing else does: with
 * the core in its own process, main held no copy of the supervisor, so the
 * automatic onboarding nudge and the `--continue` handoff found no writer and
 * were never typed. This boots the real core, runs the startup op entry.ts
 * runs, and drives the supervisor the way the app does.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { startCore } from "../src/main/junto/core";
import { runCoreOp } from "../src/main/core-process/serve";
import "../src/main/core-process/ops/index";
import { MachineCoreMail } from "../src/main/core-runtime";
import { Command } from "../src/shared/model";
import { ModelService } from "../src/main/junto/model/service";
import { MachineRepository } from "../src/main/junto/machines/repository";
import { injectionSupervisor } from "../src/main/junto/term/injection-supervisor";
import { termPlane } from "../src/main/junto/term/plane";
import { terminalObserverPlane } from "../src/main/junto/term/observer";
import { seatStateRuntime } from "../src/main/junto/term/agent-state/runtime";
import { buildOnboardNudge } from "../src/shared/managed-terminal-injection";
import { CONTINUATION_LINE } from "../src/shared/seat-sessions";

const BINDING = "nudge-binding";
const SEAT = "nudge-seat";
const CANVAS = "nudge";

afterEach(() => {
  vi.restoreAllMocks();
  injectionSupervisor.clearForTest();
});

it("the core types the onboarding nudge and the --continue line", async () => {
  const home = await mkdtemp("/tmp/junto-core-supervisor-");
  let core: Awaited<ReturnType<typeof startCore>> | undefined;
  try {
    core = await startCore({ home, build: "c".repeat(64), bundles: {} });
    // entry.ts:101, the same op main's boot runs.
    await runCoreOp(core.runtime, "ipc.startup.core", {});
    const coreMail = await core.runtime.runPromise(MachineCoreMail);
    const written: string[] = [];
    vi.spyOn(coreMail.seats.drive, "writeMail").mockImplementation(async (_bindingId, text) => {
      written.push(text);
      return "written";
    });

    // The seat, on a canvas this machine runs, with no session record: not onboarded.
    const run = core.runtime.runPromise;
    const machineName = await run(Effect.flatMap(MachineRepository, (machines) => machines.machineName));
    const command = Schema.decodeUnknownSync(Command);
    await run(Effect.flatMap(ModelService, (model) => model.command(command({ _tag: "CreateCanvas", canvas: CANVAS }), "operator")));
    await run(Effect.flatMap(ModelService, (model) => model.command(command({
      _tag: "Add", canvas: CANVAS, wires: [], nodes: [{
        kind: "agent", id: SEAT, x: 0, y: 0, width: 200, height: 100, z: 0,
        label: "Nudge", agentKey: `local:${SEAT}`, bindingId: BINDING, host: machineName,
        harness: "codex", overseer: false,
      }],
    }), "operator")));

    // The PTY and the screen are the machine's edge; the state, the wiring and
    // the mail gate below it are the core's own.
    const live = { bindingId: BINDING, canvasName: CANVAS, nodeId: SEAT, epoch: "ep-1", status: "running" };
    vi.spyOn(termPlane.host, "get").mockReturnValue(live as never);
    vi.spyOn(terminalObserverPlane, "snapshot").mockReturnValue({
      bindingId: BINDING, epoch: "ep-1", lines: [], text: "",
      signals: { modes: { bracketedPaste: true }, title: "" },
    } as never);
    vi.spyOn(seatStateRuntime, "getState").mockReturnValue("idle");
    vi.spyOn(seatStateRuntime, "isSeatIdle").mockReturnValue(true);
    vi.spyOn(seatStateRuntime.machine, "getSlot").mockReturnValue({ harness: "codex" } as never);
    vi.spyOn(seatStateRuntime, "composerVerdict").mockReturnValue("empty");

    // The seat first shows up at rest, then a message goes in and one turn runs.
    const state = (value: "working" | "idle", epoch = "ep-1") =>
      injectionSupervisor.noteSeatState({ bindingId: BINDING, epoch, state: value, reason: "test", confidence: "high", at: Date.now() });
    state("idle");
    await vi.waitFor(() => expect(injectionSupervisor.isOnboarded(BINDING)).toBe(false), { timeout: 5_000 });
    injectionSupervisor.noteMailWritten(BINDING);
    state("working");
    state("idle");
    await vi.waitFor(() => expect(written).toContain(buildOnboardNudge()), { timeout: 10_000 });

    // `junto offboard --continue` armed the fresh generation's line.
    injectionSupervisor.armContinuation(BINDING, "ep-1");
    vi.spyOn(termPlane.host, "get").mockReturnValue({ ...live, epoch: "ep-2" } as never);
    vi.spyOn(terminalObserverPlane, "snapshot").mockReturnValue({
      bindingId: BINDING, epoch: "ep-2", lines: [], text: "",
      signals: { modes: { bracketedPaste: true }, title: "" },
    } as never);
    state("idle", "ep-2");
    await vi.waitFor(() => expect(written).toContain(CONTINUATION_LINE), { timeout: 10_000 });
  } finally {
    await core?.close();
    await rm(home, { recursive: true, force: true });
  }
}, 60_000);
