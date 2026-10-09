/**
 * Per-test sandbox: a throwaway temp root holding the Electron user-data
 * dir and a sandboxed HOME — plus
 * fixture builders. Nothing here ever reads or writes the operator's real
 * ~/.junto or userData; every path lives under os.tmpdir().
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { ModelService } from "../../src/main/junto/model/service";
import { WorkModelDependentsLive } from "../../src/main/junto/work/model-dependents";
import { Command } from "../../src/shared/model";
import { modelSeedCommands, type ModelFixture } from "./model";
import {
  makeStateEngineLive,
} from "../../src/main/junto/state/engine";
import {
  SettingsLive,
  SettingsService,
} from "../../src/main/junto/settings/service";
import type { UsageState } from "../../src/shared/usage";
import type { AgentSignal } from "../../src/shared/agent-signals";
import {
  WorkRepositoryLive,
} from "../../src/main/junto/work/repository";
export interface Sandbox {
  readonly root: string;
  readonly userDataDir: string;
  readonly homeDir: string;
}

/**
 * macOS caps AF_UNIX socket paths at roughly 104 bytes (sun_path). The work,
 * operator, canvas, term, and browser control sockets all live under
 * `<home>/.junto/<plane>/control.sock`; with the canonical
 * home that is 36 bytes of suffix, so the temp root must leave room. A stock
 * `os.tmpdir()` on macOS expands to a long /var/folders/... path and pushes
 * every control socket over the limit — bind() then fails EINVAL and the app
 * fail-closes at boot. Prefer `os.tmpdir()`, but fall back to the short
 * `/tmp` root (the same trick the browser containment probe uses) whenever
 * the deepest control socket would not fit.
 */
const controlSocketFits = (root: string): boolean => {
  // Longest control plane suffix under the canonical home.
  const suffix = join("home", ".junto", "operator", "control.sock");
  // 6 random chars from mkdtemp + the "junto-e2e-" prefix.
  const longest = join(root, "junto-e2e-abcdef", suffix);
  return Buffer.byteLength(longest) <= 103;
};

export const createSandbox = async (): Promise<Sandbox> => {
  const tempRoot = controlSocketFits(tmpdir()) ? tmpdir() : "/tmp";
  const root = await mkdtemp(join(tempRoot, "junto-e2e-"));
  const userDataDir = join(root, "user-data");
  const homeDir = join(root, "home");
  const juntoDir = join(homeDir, ".junto");
  const stateDir = join(juntoDir, "state");
  await Promise.all([
    mkdir(userDataDir, { recursive: true }),
    mkdir(stateDir, { recursive: true }),
  ]);
  return {
    root,
    userDataDir,
    homeDir,
  };
};

/** Best-effort recursive removal — never throws (temp cleanup is not load-bearing). */
export const destroySandbox = async (sandbox: Sandbox): Promise<void> => {
  await rm(sandbox.root, { recursive: true, force: true }).catch(() => undefined);
};

/**
 * Historical rows are inert installed-state evidence. Seed invalid/expired
 * commercial data without restoring a runtime decoder or repository for it.
 * This engine is confined to the disposable sandbox and closes before launch.
 */
export const writeFixtureRetiredCommercialState = async (
  sandbox: Sandbox,
): Promise<void> => {
  const runtime = ManagedRuntime.make(makeStateEngineLive(
    join(sandbox.homeDir, ".junto", "state", "junto.db"),
  ));
  try {
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql.withTransaction(Effect.gen(function* () {
        const expired = JSON.stringify({
          provider: "retired-provider",
          licenseKey: "synthetic-expired-test-key",
          lastValidatedAt: "2000-01-01T00:00:00.000Z",
          validationResult: "invalid",
        });
        for (const [table, version] of [
          ["license_activation", 1],
          ["license_entitlement", 2],
        ] as const) {
          yield* sql`INSERT INTO ${sql(table)}
              (singleton, record_version, activated_license_json, updated_at)
             VALUES (1, ${version}, ${expired}, ${"2000-01-01T00:00:00.000Z"})`;
        }
      })),
    ));
  } finally {
    await runtime.dispose();
  }
};

/** Seed a disposable database through ModelService, then close its owner. */
export const writeFixtureModel = async (
  sandbox: Sandbox, name: string, fixture: ModelFixture, databasePath?: string,
): Promise<void> => {
  const state = makeStateEngineLive(databasePath ?? join(sandbox.homeDir, ".junto", "state", "junto.db"));
  const repositories = Layer.provideMerge(Layer.mergeAll(
    WorkRepositoryLive, SettingsLive,
  ), state);
  const runtime = ManagedRuntime.make(Layer.provideMerge(
    Layer.provide(ModelService.layer, WorkModelDependentsLive), repositories,
  ));
  try {
    await runtime.runPromise(Effect.gen(function* () {
      const model = yield* ModelService;
      const settings = yield* SettingsService;
      const sql = yield* SqlClient.SqlClient;
      yield* settings.setStationTopology({ role: "command-center", hostId: "local", supervisedPreferred: true });
      yield* sql.withTransaction(Effect.gen(function* () {
        const exists = (yield* model.listCanvases()).some((canvas) => canvas === name);
        if (exists) yield* model.command(Schema.decodeUnknownSync(Command)({ _tag: "RemoveCanvas", canvas: name }), "operator");
        for (const command of modelSeedCommands(name, fixture)) yield* model.command(command, "operator");
      }));
    }));
  } finally { await runtime.dispose(); }
};

/**
 * Remove canvases from an explicit database, keeping only the seeded names.
 * Demo-mode apps mint an ephemeral product database and create an empty
 * default canvas at first boot; launchJunto removes it so the renderer
 * boots onto the seeded canvas instead of the empty default.
 */
export const removeFixtureCanvases = async (
  sandbox: Sandbox,
  databasePath: string,
  keep: ReadonlySet<string>,
): Promise<void> => {
  const state = makeStateEngineLive(databasePath);
  const repositories = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      SettingsLive,
    ),
    state,
  );
  const runtime = ManagedRuntime.make(Layer.provideMerge(
    Layer.provide(ModelService.layer, WorkModelDependentsLive), repositories,
  ));
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const model = yield* ModelService;
        for (const canvasName of yield* model.listCanvases()) {
          if (keep.has(canvasName)) continue;
          yield* model.command(Schema.decodeUnknownSync(Command)({ _tag: "RemoveCanvas", canvas: canvasName }), "operator");
        }
      }),
    );
  } finally {
    await runtime.dispose();
  }
};

/**
 * Seed a usage-plane last-good state into the same explicit SQLite database
 * Electron opens. This is the product's durable seam (`usage_state` row):
 * UsageCache paints it at boot and UsageService keeps it when a live poll
 * fails, so scenarios drive the native HUD without touching any source.
 */
export const writeFixtureUsageState = async (
  sandbox: Sandbox,
  state: UsageState,
  databasePath?: string,
): Promise<void> => {
  const runtime = ManagedRuntime.make(
    makeStateEngineLive(
      databasePath ??
        join(sandbox.homeDir, ".junto", "state", "junto.db"),
    ),
  );
  try {
    const sql = await runtime.runPromise(SqlClient.SqlClient);
    await runtime.runPromise(sql.withTransaction(
      sql`INSERT INTO usage_state(singleton, snapshots_json, last_live_at, updated_at)
         VALUES (1, ${JSON.stringify(state.snapshots)}, ${state.lastLiveAt ?? new Date().toISOString()}, ${new Date().toISOString()})
         ON CONFLICT(singleton) DO UPDATE SET
           snapshots_json = excluded.snapshots_json,
           last_live_at = excluded.last_live_at,
           updated_at = excluded.updated_at`,
    ));
  } finally {
    await runtime.dispose();
  }
};

/** Agent signals seeded as durable rows, as if their seats had raised them. */
export const writeFixtureAgentSignals = async (
  sandbox: Sandbox,
  signals: ReadonlyArray<AgentSignal>,
): Promise<void> => {
  const runtime = ManagedRuntime.make(
    makeStateEngineLive(join(sandbox.homeDir, ".junto", "state", "junto.db")),
  );
  try {
    const sql = await runtime.runPromise(SqlClient.SqlClient);
    await runtime.runPromise(sql.withTransaction(Effect.gen(function* () {
      for (const signal of signals) {
        yield* sql`INSERT INTO agent_signals(
             signal_id, canvas_name, node_id, kind, text, detail, created_at,
             state, response_text, response_at, closed_at)
           VALUES (${signal.signalId}, ${signal.canvasName}, ${signal.nodeId}, ${signal.kind},
             ${signal.text}, ${signal.detail ?? null}, ${signal.createdAt}, ${signal.state},
             ${signal.response?.text ?? null}, ${signal.response?.at ?? null}, ${signal.closedAt ?? null})`;
      }
    })));
  } finally {
    await runtime.dispose();
  }
};
