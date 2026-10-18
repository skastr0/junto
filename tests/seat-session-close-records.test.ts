/**
 * The session record at the ends that do not go through the offboard closer:
 * a reseat, a fresh start, a new occupant's pin, and a new id that replaces
 * the open session (a resume that failed open, a capture). Each is driven
 * through the real stores and writes exactly one record beside the notes,
 * naming how the session ended. The closer's own ends are in
 * seat-offboard-close.test.ts.
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { seat } from "./support/model-nodes";
import { seedThisMachine } from "./support/seed-this-machine";
import { asCanvasName, asNodeId } from "../src/shared/model";
import type { SessionRecord } from "../src/shared/seat-session-record";
import { ModelService } from "../src/main/junto/model/service";
import { WorkLive } from "../src/main/junto/work/service";
import { CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { makeContentServiceLive } from "../src/main/junto/content/service";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { MachineRepository, makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import { SettingsLive } from "../src/main/junto/settings/service";
import { AgentSignalRepositoryLive } from "../src/main/junto/signals/repository";
import { makeSeatSessionRepositoryLive, SeatSessionRepository } from "../src/main/junto/seat-sessions/repository";
import { startSeatSessionRecorder } from "../src/main/junto/seat-sessions/service";

const app = vi.hoisted(() => ({ runPromise: vi.fn() }));
vi.mock("../src/main/core-runner", () => ({ coreRunner: app }));
import { ensureSeatSessionId } from "../src/main/junto/term/seat-session-before-start";
import { writeSeatSessionId } from "../src/main/junto/term/seat-session-id";

const MACHINE = "workbench";
const CANVAS = "records";
const FRESH = "019a0000-0000-7000-8000-00000000c0c0";

const makeRuntime = (root: string) => {
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      makeSeatSessionRepositoryLive(join(root, "seats")),
      AgentSignalRepositoryLive,
      makeMachineRepositoryLive({ defaultName: () => MACHINE }),
      SettingsLive,
      makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
    ),
    Layer.mergeAll(
      makeStateEngineLive(join(root, "state", "junto.db")),
      makeInstallOpsLive(join(root, "state", "install-ops.db")),
    ),
  );
  return ManagedRuntime.make(Layer.provideMerge(WorkLive, Layer.provideMerge(ModelStoresLive, repositoriesLive)));
};

let root: string;
let runtime: ReturnType<typeof makeRuntime>;
let failures: string[];

beforeEach(async () => {
  seedThisMachine();
  root = await mkdtemp(join(tmpdir(), "junto-close-records-"));
  const live = (runtime = makeRuntime(root));
  app.runPromise.mockImplementation((effect) => live.runPromise(effect));
  await live.runPromise(Effect.flatMap(MachineRepository, (machine) => machine.configureName(MACHINE)));
  await live.runPromise(
    seedCanvas(CANVAS, [
      seat("seat", { host: MACHINE, bindingId: "bind-1" as never, launch: { kind: "harness", argv: ["claude"], cwd: "/tmp" } }),
    ]),
  );
  // A record that could not be written is logged; none may be.
  failures = [];
  const error = console.error.bind(console);
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    failures.push(args.map(String).join(" "));
    error(...args);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  app.runPromise.mockReset();
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const start = async (bindingId = "bind-1", fresh = false) => {
  const selected = await ensureSeatSessionId({
    canvasName: CANVAS,
    nodeId: "seat",
    bindingId,
    harness: "claude",
    cwd: "/tmp",
    ...(fresh ? { fresh } : {}),
  });
  if (!selected.ok) throw new Error(selected.reason);
  return selected.sessionId;
};

const reseat = (bindingId: string) =>
  runtime.runPromise(
    Effect.flatMap(ModelService, (model) =>
      model.command(
        {
          _tag: "Reseat",
          canvas: asCanvasName(CANVAS),
          id: asNodeId("seat"),
          agentKey: `${MACHINE}:claude`,
          bindingId: bindingId as never,
          harness: "claude",
          host: MACHINE as never,
          launch: { kind: "harness", argv: ["claude"], cwd: "/tmp" },
        },
        "operator",
      ),
    ),
  );

/** Every record written beside the seat's notes: which session, and how it ended. */
const records = async () => {
  const dir = join(root, "seats", "seat", "sessions");
  const files = (await readdir(dir).catch(() => [] as string[])).filter((file) => file.endsWith(".record.json"));
  const read = await Promise.all(
    files.map(async (file) => JSON.parse(await readFile(join(dir, file), "utf8")) as SessionRecord),
  );
  return read.map((record) => ({ session: record.session.id, endedBy: record.session.ended_by }));
};

const openSession = () =>
  runtime.runPromise(Effect.flatMap(SeatSessionRepository, (sessions) => sessions.list("seat"))).then(
    (history) => history.find((session) => session.endedAt === undefined)?.sessionId,
  );

describe("the record at an end outside the offboard closer", () => {
  it("a start that ends nothing writes none", async () => {
    const first = await start();
    expect(await start()).toBe(first);
    expect(await records()).toEqual([]);
  });

  it("a fresh start ends the open session as replaced and writes its record once", async () => {
    const old = await start();
    const next = await start("bind-1", true);
    expect(next).not.toBe(old);
    expect(await records()).toEqual([{ session: old, endedBy: "replaced" }]);
    await start();
    expect(await records()).toHaveLength(1);
    expect(failures).toEqual([]);
  });

  it("a new occupant's pin ends the former occupant's session as reseat", async () => {
    const old = await start();
    // The canvas changed while nothing was watching it: the start finds it.
    await reseat("bind-2");
    const next = await start("bind-2");
    expect(next).not.toBe(old);
    expect(await records()).toEqual([{ session: old, endedBy: "reseat" }]);
    expect(failures).toEqual([]);
  });

  it("a reseat the recorder sees ends the former occupant's session and writes its record once", async () => {
    const old = await start();
    const flights: Array<Promise<void>> = [];
    const stop = await runtime.runPromise(startSeatSessionRecorder((effect) => void flights.push(runtime.runPromise(effect))));
    try {
      await reseat("bind-2");
      await vi.waitFor(() => expect(flights.length).toBeGreaterThan(0));
      await Promise.all(flights);
      expect(await records()).toEqual([{ session: old, endedBy: "reseat" }]);
      // The new occupant's first start ends nothing more.
      await start("bind-2");
      expect(await records()).toHaveLength(1);
    } finally {
      stop();
    }
    expect(failures).toEqual([]);
  });

  it("a new id that replaces the open session (a resume that failed open) writes the replaced one's record once", async () => {
    const old = await start();
    const written = await writeSeatSessionId({
      canvasName: CANVAS,
      nodeId: "seat",
      bindingId: "bind-1",
      harness: "claude",
      sessionId: FRESH,
      cwd: "/tmp",
    });
    expect(written).toEqual({ ok: true });
    expect(await openSession()).toBe(FRESH);
    expect(await records()).toEqual([{ session: old, endedBy: "replaced" }]);
    // The same id again is already the seat's: nothing ends.
    await writeSeatSessionId({ canvasName: CANVAS, nodeId: "seat", bindingId: "bind-1", harness: "claude", sessionId: FRESH });
    expect(await records()).toHaveLength(1);
    expect(failures).toEqual([]);
  });
});
