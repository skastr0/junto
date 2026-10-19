/**
 * Which session the next wake resumes, after a start the operator asked to be
 * fresh and after a resume that failed open. Each case drives the start, then
 * a second wake, through the real session store, and checks that the card
 * line (seatNextLaunch) says what that wake does.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedCanvas } from "./support/seed-canvas";
import { seat } from "./support/model-nodes";
import type { Node } from "../src/shared/model";
import { seatNextLaunch } from "../src/shared/seat-next-launch";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { ModelService } from "../src/main/junto/model/service";
import { ModelDependents } from "../src/main/junto/model/dependents";
import { makeSeatSessionRepositoryLive, SeatSessionRepository } from "../src/main/junto/seat-sessions/repository";
import { MachineRepository, makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import { makeManagedSpawnIntent } from "../src/main/junto/term/managed-spawn-plan";
import { LocalSessionHost } from "../src/main/junto/term/local-host";
import { makeProcessIdentityMap, setProcessIdentityMapForTests } from "../src/main/junto/process-identity";
import { setProcessEpochReaderForTests } from "../src/main/junto/process-epoch";
import { makeFakeTerminalProcessAuthority } from "./helpers/fake-terminal-process-authority";
import { installHermeticHarnessBins } from "./helpers/hermetic-harness-bins";
import { seedThisMachine, clearMachines } from "./support/seed-this-machine";

const app = vi.hoisted(() => ({ runPromise: vi.fn() }));
vi.mock("../src/main/core-runner", () => ({ coreRunner: app }));
import { ensureSeatSessionId } from "../src/main/junto/term/seat-session-before-start";
import type { SeatThreadResult } from "../src/main/junto/term/amp-seat-thread";
import { writeSeatSessionId } from "../src/main/junto/term/seat-session-id";

const MACHINE = "command";
const CANVAS = "next-wake";
const OLD = "019a0000-0000-7000-8000-00000000a0a0";
const NEW = "019a0000-0000-7000-8000-00000000b0b0";

const agent = (harness: "codex" | "claude"): Node =>
  seat("seat", {
    label: "Agent" as never,
    agentKey: `${MACHINE}:seat`,
    host: MACHINE,
    bindingId: "binding-seat" as never,
    harness,
    launch: { kind: "harness", argv: [harness], cwd: "/tmp" },
  });

const makeRuntime = (root: string) => ManagedRuntime.make(Layer.provideMerge(
  Layer.provide(ModelService.layer, ModelDependents.empty),
  Layer.provideMerge(
    Layer.mergeAll(makeSeatSessionRepositoryLive(), makeMachineRepositoryLive({ defaultName: () => MACHINE })),
    makeStateEngineLive(join(root, "state.db")),
  ),
));

let runtime: ReturnType<typeof makeRuntime> | undefined;
let root: string | undefined;
let restoreBins: (() => void) | undefined;

const fixture = async (harness: "codex" | "claude") => {
  root = await mkdtemp(join(tmpdir(), "junto-next-wake-"));
  const live = runtime = makeRuntime(root);
  app.runPromise.mockImplementation((effect) => live.runPromise(effect));
  await live.runPromise(Effect.flatMap(MachineRepository, (machine) => machine.configureName(MACHINE)));
  const node = agent(harness);
  await live.runPromise(seedCanvas(CANVAS, [node]));
  const start = (fresh?: boolean) => ensureSeatSessionId({
    canvasName: CANVAS, nodeId: node.id, bindingId: "binding-seat", harness, cwd: "/tmp",
    ...(fresh ? { fresh } : {}),
  });
  const open = () => live.runPromise(Effect.flatMap(SeatSessionRepository, (sessions) => sessions.current(node.id, "binding-seat")));
  /** What the card says the next start does, with the harness store proving whatever is open. */
  const card = async () => {
    const session = await open();
    const history = await live.runPromise(Effect.flatMap(SeatSessionRepository, (sessions) => sessions.list(node.id)));
    const lastEnded = history.find((row) => row.endedAt !== undefined)?.endReason;
    return seatNextLaunch({
      harness,
      ...(session ? { open: { harness: session.harness, sessionId: session.sessionId } } : {}),
      provisioned: false,
      provenOnDisk: session !== undefined,
      ...(lastEnded ? { lastEnded } : {}),
    });
  };
  /** The spawn intent a wake builds from what the start named, as seat-control builds it. */
  const intent = (selected: SeatThreadResult, resume = true) => {
    if (!selected.ok) throw new Error(selected.reason);
    return makeManagedSpawnIntent({ harness, cwd: "/tmp", sessionId: selected.sessionId || undefined,
      resume: selected.minted ? false : resume });
  };
  return { node, start, open, card, intent };
};

/** Codex's id exists only once it runs; the seat captures it after spawn. */
const capture = (nodeId: string, sessionId: string) => writeSeatSessionId({
  canvasName: CANVAS, nodeId, sessionId, onlyIfAbsent: true,
  capture: { bindingId: "binding-seat", harness: "codex", isCurrent: () => true },
});

beforeEach(() => {
  seedThisMachine();
});

afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
  app.runPromise.mockReset();
  restoreBins?.();
  restoreBins = undefined;
  setProcessIdentityMapForTests(undefined);
  setProcessEpochReaderForTests(undefined);
  clearMachines();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("a fresh start", () => {
  it("ends a capture seat's old session, so the second wake resumes the new one", async () => {
    const f = await fixture("codex");
    expect(await f.start()).toEqual({ ok: true, sessionId: "", minted: false });
    expect(await capture(f.node.id, OLD)).toEqual({ ok: true });
    expect(await f.card()).toBe("resume");

    const fresh = await f.start(true);
    expect(fresh).toEqual({ ok: true, sessionId: "", minted: false });
    expect(f.intent(fresh, false)).not.toHaveProperty("sessionId");
    expect(await f.card()).toBe("fresh");
    expect(await capture(f.node.id, NEW)).toEqual({ ok: true });

    const wake = await f.start();
    expect(wake).toEqual({ ok: true, sessionId: NEW, minted: false });
    expect(f.intent(wake)).toMatchObject({ sessionId: NEW, resumeRequested: true });
    expect(await f.card()).toBe("resume");
  });

  it("pins a new session for a pin seat, and the second wake resumes that one", async () => {
    const f = await fixture("claude");
    const first = await f.start();
    expect(first).toMatchObject({ ok: true, minted: true });
    const old = first.ok ? first.sessionId : "";

    const fresh = await f.start(true);
    expect(fresh).toMatchObject({ ok: true, minted: true });
    const pinned = fresh.ok ? fresh.sessionId : "";
    expect(pinned).not.toBe(old);
    expect(f.intent(fresh, false)).toMatchObject({ sessionId: pinned, resumeRequested: false });

    const wake = await f.start();
    expect(wake).toEqual({ ok: true, sessionId: pinned, minted: false });
    expect(f.intent(wake)).toMatchObject({ sessionId: pinned, resumeRequested: true });
    expect(await f.card()).toBe("resume");
  });

  it("a plain start keeps the open session", async () => {
    const f = await fixture("codex");
    await f.start();
    await capture(f.node.id, OLD);
    expect(await f.start()).toEqual({ ok: true, sessionId: OLD, minted: false });
    expect(await f.start()).toEqual({ ok: true, sessionId: OLD, minted: false });
  });
});

describe("a resume that fails open", () => {
  it("records the fresh session, so the second wake resumes it and not the dead id", async () => {
    const priorHome = process.env.JUNTO_HOME;
    delete process.env.JUNTO_HOME;
    restoreBins = installHermeticHarnessBins();
    setProcessIdentityMapForTests(makeProcessIdentityMap({
      processAlive: () => true, readProcessStartKey: (pid) => `synthetic-${pid}`,
    }));
    setProcessEpochReaderForTests({ snapshot: () => [] });
    const fake = makeFakeTerminalProcessAuthority((_spec, index) => ({
      pid: 42_700 + index,
      // The resume generation is dead on arrival; the fresh pin lives.
      ...(index === 0 ? { exitImmediately: true as const } : {}),
      exitOnSignal: "SIGTERM",
    }));
    const host = new LocalSessionHost(fake.authority, { killGraceMs: 5, shutdownGraceMs: 5, lateExitGraceMs: 5 });
    try {
      const f = await fixture("claude");
      const first = await f.start();
      const dead = first.ok ? first.sessionId : "";
      expect(await f.start()).toEqual({ ok: true, sessionId: dead, minted: false });

      host.createAgentSeat({
        bindingId: "binding-seat",
        harness: "claude",
        agentKey: `${MACHINE}:seat`,
        launch: { kind: "harness", argv: ["claude", "--resume", dead], cwd: "/tmp" },
        canvasName: CANVAS,
        nodeId: f.node.id,
      });
      await vi.waitFor(() => expect(fake.controllers).toHaveLength(2));
      const args = fake.controllers[1]!.spec.args ?? [];
      expect(args).not.toContain("--resume");
      const freshId = args[args.indexOf("--session-id") + 1]!;
      expect(freshId).toBeTruthy();
      expect(freshId).not.toBe(dead);

      await vi.waitFor(async () => expect((await f.open())?.sessionId).toBe(freshId));
      const wake = await f.start();
      expect(wake).toEqual({ ok: true, sessionId: freshId, minted: false });
      expect(f.intent(wake)).toMatchObject({ sessionId: freshId, resumeRequested: true });
      expect(await f.card()).toBe("resume");
    } finally {
      await host.shutdownAll("test_cleanup");
      if (priorHome === undefined) delete process.env.JUNTO_HOME;
      else process.env.JUNTO_HOME = priorHome;
    }
  });
});
