import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  makeSchedulerRepositoryLive,
  SchedulerRepository,
  SchedulerStateCorruptError,
} from "../src/main/vellum/scheduler/repository";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum/state/engine";

const roots: string[] = [];
const runtimes: Array<{ readonly dispose: () => Promise<void> }> = [];
let scheduleIdentity = 0;

afterEach(async () => {
  while (runtimes.length > 0) {
    await runtimes.pop()!.dispose();
  }
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

const makeRuntime = async (databasePath?: string) => {
  const root =
    databasePath === undefined
      ? await mkdtemp(join(tmpdir(), "vellum-scheduler-"))
      : undefined;
  if (root !== undefined) roots.push(root);
  const path = databasePath ?? join(root!, "vellum.db");
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      makeSchedulerRepositoryLive({
        makeScheduleId: () => `schedule-${++scheduleIdentity}`,
        now: (epoch) => new Date(epoch).toISOString(),
      }),
      makeStateEngineLive(path),
    ),
  );
  runtimes.push(runtime);
  return { runtime, path };
};

const claimInput = (
  nowEpochMs: number,
  overrides: Partial<
    Parameters<
      Context.Tag.Service<typeof SchedulerRepository>["claimInterval"]
    >[0]
  > = {},
) => ({
  timerKey: "canvas-a::timer-a",
  localStationId: "mini",
  homeStationIds: ["mini"],
  nowEpochMs,
  everyMinutes: 1,
  ...overrides,
});

describe("SchedulerRepository", () => {
  it("coalesces missed intervals transactionally and never replays a claimed slot", async () => {
    const { runtime } = await makeRuntime();
    const scheduler = await runtime.runPromise(SchedulerRepository);
    const state = await runtime.runPromise(StateEngine);

    const initialized = await runtime.runPromise(
      scheduler.claimInterval(claimInput(1_000_000)),
    );
    expect(initialized).toMatchObject({
      _tag: "Initialized",
      state: {
        catchUpPolicy: "coalesce-latest",
        nextDueAtEpochMs: 1_060_000,
        nextDueSlot: "0",
      },
    });

    const early = await runtime.runPromise(
      scheduler.claimInterval(claimInput(1_059_999)),
    );
    expect(early._tag).toBe("NotDue");

    const fired = await runtime.runPromise(
      scheduler.claimInterval(claimInput(1_250_000)),
    );
    expect(fired).toMatchObject({
      _tag: "Firing",
      catchUpPolicy: "coalesce-latest",
      dueSlot: "3",
      scheduledForEpochMs: 1_240_000,
      coalescedMissedSlots: "3",
      nextState: {
        catchUpPolicy: "coalesce-latest",
        nextDueAtEpochMs: 1_300_000,
        nextDueSlot: "4",
        lastFiredSlot: "3",
      },
    });

    const duplicate = await runtime.runPromise(
      scheduler.claimInterval(claimInput(1_250_000)),
    );
    expect(duplicate._tag).toBe("NotDue");

    const receipts = await runtime.runPromise(
      state.read("test.scheduler-receipts", (reader) =>
        reader.get<{
          readonly count: number;
          readonly catch_up_policy: string;
        }>(
          `
            SELECT
              count(*) AS count,
              min(catch_up_policy) AS catch_up_policy
            FROM scheduler_interval_firings
          `,
        )
      ),
    );
    expect(receipts).toEqual({
      count: 1,
      catch_up_policy: "coalesce-latest",
    });
  });

  it("persists its cursor across restart and resets only when the interval changes", async () => {
    const first = await makeRuntime();
    const scheduler = await first.runtime.runPromise(SchedulerRepository);
    await first.runtime.runPromise(
      scheduler.claimInterval(claimInput(1_000_000)),
    );
    await first.runtime.runPromise(
      scheduler.claimInterval(claimInput(1_060_000)),
    );
    await first.runtime.dispose();
    runtimes.splice(runtimes.indexOf(first.runtime), 1);

    const second = await makeRuntime(first.path);
    const restarted = await second.runtime.runPromise(SchedulerRepository);
    const noReplay = await second.runtime.runPromise(
      restarted.claimInterval(claimInput(1_060_000)),
    );
    expect(noReplay._tag).toBe("NotDue");

    const before = await second.runtime.runPromise(
      restarted.readIntervalState("mini", "canvas-a::timer-a"),
    );
    const reset = await second.runtime.runPromise(
      restarted.claimInterval(
        claimInput(1_070_000, { everyMinutes: 2 }),
      ),
    );
    expect(reset).toMatchObject({
      _tag: "Initialized",
      state: {
        intervalMilliseconds: 120_000,
        nextDueAtEpochMs: 1_190_000,
        nextDueSlot: "0",
      },
    });
    if (reset._tag !== "Initialized") return;
    expect(reset.state.scheduleId).not.toBe(before?.scheduleId);
  });

  it("fails closed for foreign/ambiguous homes and persists no cursor", async () => {
    const { runtime } = await makeRuntime();
    const scheduler = await runtime.runPromise(SchedulerRepository);

    const foreign = await runtime.runPromise(
      scheduler.claimInterval(
        claimInput(1_000_000, { homeStationIds: ["studio"] }),
      ),
    );
    expect(foreign).toEqual({
      _tag: "Ineligible",
      reason: "foreign-home",
    });
    const ambiguous = await runtime.runPromise(
      scheduler.claimInterval(
        claimInput(1_000_000, {
          homeStationIds: ["mini", "mini"],
        }),
      ),
    );
    expect(ambiguous).toEqual({
      _tag: "Ineligible",
      reason: "ambiguous-home",
    });
    await expect(
      runtime.runPromise(
        scheduler.readIntervalState("mini", "canvas-a::timer-a"),
      ),
    ).resolves.toBeUndefined();
  });

  it("reconciles removed timers so a later re-add starts a new schedule", async () => {
    const { runtime } = await makeRuntime();
    const scheduler = await runtime.runPromise(SchedulerRepository);

    const first = await runtime.runPromise(
      scheduler.claimInterval(claimInput(1_000_000)),
    );
    expect(first._tag).toBe("Initialized");
    const removed = await runtime.runPromise(
      scheduler.reconcileHome("mini", []),
    );
    expect(removed).toBe(1);

    const readded = await runtime.runPromise(
      scheduler.claimInterval(claimInput(1_010_000)),
    );
    expect(readded._tag).toBe("Initialized");
    if (
      first._tag !== "Initialized" ||
      readded._tag !== "Initialized"
    ) {
      return;
    }
    expect(readded.state.scheduleId).not.toBe(first.state.scheduleId);
    expect(readded.state.nextDueAtEpochMs).toBe(1_070_000);
  });

  it("allows only one claimant to advance a due cursor", async () => {
    const { runtime } = await makeRuntime();
    const scheduler = await runtime.runPromise(SchedulerRepository);
    await runtime.runPromise(
      scheduler.claimInterval(claimInput(1_000_000)),
    );

    const results = await Promise.all([
      runtime.runPromise(
        scheduler.claimInterval(claimInput(1_060_000)),
      ),
      runtime.runPromise(
        scheduler.claimInterval(claimInput(1_060_000)),
      ),
    ]);
    expect(results.filter((result) => result._tag === "Firing")).toHaveLength(
      1,
    );
    expect(results.filter((result) => result._tag === "NotDue")).toHaveLength(
      1,
    );
  });

  it("fails closed when the persisted catch-up policy is corrupt", async () => {
    const { runtime } = await makeRuntime();
    const scheduler = await runtime.runPromise(SchedulerRepository);
    const state = await runtime.runPromise(StateEngine);
    await runtime.runPromise(
      scheduler.claimInterval(claimInput(1_000_000)),
    );

    await runtime.runPromise(
      state.transaction("test.corrupt-scheduler-policy", (writer) => {
        writer.run("PRAGMA ignore_check_constraints = ON");
        writer.run(
          `
            UPDATE scheduler_interval_state
            SET catch_up_policy = 'replay-all'
            WHERE home_station = ? AND timer_key = ?
          `,
          ["mini", "canvas-a::timer-a"],
        );
        writer.run("PRAGMA ignore_check_constraints = OFF");
      }),
    );

    const result = await runtime.runPromise(
      Effect.either(
        scheduler.readIntervalState("mini", "canvas-a::timer-a"),
      ),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(SchedulerStateCorruptError);
    }
  });
});
