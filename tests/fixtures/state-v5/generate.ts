/**
 * Audit generator for the pre-retirement operator-flags fixture.
 *
 * Writes `flags-v5.db`: a schema-v5 Command Center whose `factory` canvas was
 * authored while operator flags, `flagOnUnsatisfied`, the `flags` verb and
 * pad/sheet `announces` were legal. One task is created through WorkService,
 * so the immutable work log holds rows the migration must not touch.
 *
 * Never imported by the suite. It only runs against a tree where flags are
 * still in the grammar (the commit before their retirement); the migration
 * test pins the committed bytes by SHA-256. To re-run, check out that commit
 * and execute it through a one-off vitest tool file:
 *
 *   import { it } from "vitest";
 *   import { generateFlagsFixture } from "./fixtures/state-v5/generate";
 *   it("gen", () => generateFlagsFixture("tests/fixtures/state-v5/flags-v5.db"), 60_000);
 *
 * with JUNTO_TEST_FEATURE_PROFILE=all-on.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { CanvasDoc } from "../../../src/shared/canvas";
import { CanvasesLive, CanvasesService } from "../../../src/main/junto/canvases";
import { makeInstallOpsLive } from "../../../src/main/junto/install-ops/engine";
import { makeContentServiceLive } from "../../../src/main/junto/content/service";
import { makeStateEngineLive } from "../../../src/main/junto/state/engine";
import { SettingsLive, SettingsService } from "../../../src/main/junto/settings/service";
import { StationFleetTargetRepositoryLive } from "../../../src/main/junto/station/fleet-target-repository";
import { StationRepositoryLive } from "../../../src/main/junto/station/repository";
import { StationLivePeerRegistryLive } from "../../../src/main/junto/station/session-registry";
import { CrewRepositoryLive } from "../../../src/main/junto/work/crew-repository";
import { WorkRepositoryLive } from "../../../src/main/junto/work/repository";
import { WorkLive, WorkService } from "../../../src/main/junto/work/service";

const agent = (id: string, x: number, extra: Record<string, unknown> = {}) => ({
  id,
  type: "text" as const,
  text: id,
  x,
  y: 0,
  width: 240,
  height: 72,
  ether: {
    entity: { kind: "agent", name: `local:${id}` },
    terminal: {
      bindingId: `fixture-flags-${id}`,
      launch: { kind: "harness", argv: ["codex"] },
      harness: "codex",
    },
    host: "local",
    ...extra,
  },
});

const node = (id: string, kind: string, x: number, y: number, ether: Record<string, unknown> = {}) => ({
  id,
  type: "text" as const,
  text: id,
  x,
  y,
  width: 200,
  height: 80,
  ether: { entity: { kind }, ...ether },
});

export const FLAGS_FIXTURE_DOC = {
  nodes: [
    // A blocker seat: the mirror law stamps crimson `color: "1"` on save.
    agent("agent", 0, { flags: ["blocker"] }),
    agent("peer", 300, { flags: ["attention", "parked"] }),
    node("tasks", "task", 0, 200, { flags: ["parked"] }),
    node("pad", "pad", 300, 200),
    node("relay", "relay", 600, 200),
    node("cron", "cron", 900, 200, { timer: { expression: "0 9 * * *" } }),
    node("gauge", "watcher", 900, 400, {
      watch: { kind: "stat_threshold", source: "hermes", key: "local:agent", stat: "load", op: "gt", value: 3, flagOnUnsatisfied: true },
    }),
    // A plain note keeps an authored red that no flag stamped.
    { id: "note", type: "text" as const, text: "keep red", x: 0, y: 400, width: 200, height: 80, color: "1" },
  ],
  edges: [
    { id: "claim-edge", fromNode: "tasks", toNode: "agent", ether: { verb: "works" } },
    { id: "agent-announces", fromNode: "agent", toNode: "relay", ether: { verb: "announces" } },
    { id: "task-announces", fromNode: "tasks", toNode: "relay", ether: { verb: "announces" } },
    { id: "pad-announces", fromNode: "pad", toNode: "relay", ether: { verb: "announces" } },
    { id: "relay-wakes", fromNode: "relay", toNode: "peer", ether: { verb: "wakes" } },
    { id: "relay-flags", fromNode: "relay", toNode: "agent", ether: { verb: "flags" } },
    { id: "cron-flags", fromNode: "cron", toNode: "tasks", ether: { verb: "flags" } },
  ],
} as unknown as CanvasDoc;

export const generateFlagsFixture = async (path: string): Promise<void> => {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(`${path}${suffix}`)) unlinkSync(`${path}${suffix}`);
  }
  // Author in a scratch directory (content and install-ops live beside the
  // database), then copy only the closed database into place.
  const scratch = mkdtempSync(join(tmpdir(), "junto-flags-fixture-"));
  const db = join(scratch, "junto.db");
  const repositories = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      StationRepositoryLive,
      StationFleetTargetRepositoryLive,
      SettingsLive,
      makeContentServiceLive({ root: join(scratch, "content"), skipInlineMediaMigration: true }),
    ),
    Layer.mergeAll(makeStateEngineLive(db), makeInstallOpsLive(join(scratch, "install-ops.db"))),
  );
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      WorkLive,
      Layer.mergeAll(Layer.provideMerge(CanvasesLive, repositories), StationLivePeerRegistryLive) as never,
    ),
  );
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const settings = yield* SettingsService;
        yield* settings.setStationTopology({ role: "command-center", hostId: "local", supervisedPreferred: true });
        const canvases = yield* CanvasesService;
        yield* canvases.create("factory");
        yield* canvases.write("factory", FLAGS_FIXTURE_DOC);
        const work = yield* WorkService;
        yield* work.workTaskCreate("factory", "tasks", "ship the flag retirement", { details: "ship it" });
      }) as unknown as Effect.Effect<void, unknown, never>,
    );
    await runtime.dispose();
    copyFileSync(db, path);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};
