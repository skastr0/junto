/**
 * Durable writes are attributed to the operation that made them.
 *
 * Canvas READS were already tagged for the perf probe, so a slow read names
 * its caller. Writes were not — which is exactly why a 286ms main-thread block
 * during node creation, measured on the operator's machine, arrived with no
 * caller attached and could not be chased. Every durable write in the app
 * funnels through `StateEngine.transaction`, so instrumenting that one place
 * names all of them.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Effect, ManagedRuntime } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import {
  armMainThreadBudget,
  resetMainThreadBudget,
  type BudgetViolation,
} from "../src/main/vellum-command/observability/main-thread-budget";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum-command/state/engine";

const roots: string[] = [];
const runtimes: Array<{ dispose: () => Promise<void> }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  resetMainThreadBudget();
  while (runtimes.length > 0) await runtimes.pop()!.dispose();
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

const openEngine = async () => {
  const root = await mkdtemp(join(tmpdir(), "vellum-command-write-budget-"));
  roots.push(root);
  const runtime = ManagedRuntime.make(
    makeStateEngineLive(join(root, "state", "vellum-command.db")),
  );
  runtimes.push(runtime);
  return runtime;
};

it("names the operation behind a write that blows the main-thread budget", async () => {
  const seen: Array<BudgetViolation> = [];
  armMainThreadBudget({
    enabled: true,
    force: true,
    budgetMs: 1,
    report: (violation) => seen.push(violation),
  });

  const runtime = await openEngine();
  await runtime.runPromise(
    Effect.flatMap(StateEngine, (engine) =>
      engine.transaction("test.slow-write", (writer) => {
        // Real synchronous work inside the transaction, not a fake clock: the
        // budget measures wall time around the body and cannot be preempted.
        const startedAt = performance.now();
        while (performance.now() - startedAt < 5) {
          writer.get<{ readonly n: number }>("SELECT 1 AS n");
        }
      }),
    ),
  );

  const violation = seen.find((entry) => entry.operation === "state.test.slow-write");
  expect(violation).toBeDefined();
  expect(violation!.ms).toBeGreaterThan(1);
});

it("stays silent for a write inside the budget", async () => {
  const runtime = await openEngine();
  // This checks the reporting threshold, not filesystem speed under parallel
  // test load. The slow-write case above still exercises a real elapsed clock.
  let elapsed = 100;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  const seen: Array<BudgetViolation> = [];
  armMainThreadBudget({
    enabled: true,
    force: true,
    report: (violation) => seen.push(violation),
  });

  await runtime.runPromise(
    Effect.flatMap(StateEngine, (engine) =>
      engine.transaction("test.fast-write", (writer) => {
        writer.get<{ readonly n: number }>("SELECT 1 AS n");
        elapsed += 1;
      }),
    ),
  );

  expect(seen.map((entry) => entry.operation)).not.toContain("state.test.fast-write");
});
