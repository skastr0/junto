import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { Context, Effect, Layer, Schema } from "effect";
import type { ServiceCheck, StationInfo } from "@shared/contracts";
import { resolvedSpawnEnv } from "../vellum/adapters/exec";
import { runProcess } from "./process";

const PRISM_ROOT = "/Users/developer/Projects/prism";

export class PrismError extends Schema.TaggedError<PrismError>()("PrismError", {
  message: Schema.String,
}) {}

/**
 * effect-foundation **S4-rest-main** (staged, not half-migrated):
 * - Canonical id: `@chassis/PrismService` — single definition; no dual path.
 * - Service id: Context.Service (Effect V4 live).
 * - Shape:
 *   `class PrismService extends Context.Service<PrismService, PrismService>()("@chassis/PrismService") {}`
 * - Layer today: PrismLive — V4 rename candidate PrismService.layer
 *   Do not dual-export Live + `.layer` names.
 */
export class PrismService extends Context.Service<PrismService,
  {
    readonly stationInfo: Effect.Effect<StationInfo>;
    readonly doctor: Effect.Effect<ServiceCheck>;
    readonly dryRunCodexCompile: Effect.Effect<ServiceCheck, PrismError>;
  }>()("@chassis/PrismService") {}

const stationPluginPath = () =>
  app.isPackaged ? join(process.resourcesPath, "station") : join(app.getAppPath(), "station");

const compiledHarnessProjectPath = () => join(app.getPath("userData"), "compiled");

export const PrismLive = Layer.succeed(
  PrismService,
  PrismService.of({
    stationInfo: Effect.sync(() => ({
      name: "chassis",
      version: app.getVersion(),
      userDataPath: app.getPath("userData"),
      stationPluginPath: stationPluginPath(),
      prismRoot: PRISM_ROOT,
    })),
    doctor: Effect.sync((): ServiceCheck => {
      const prismPackage = join(PRISM_ROOT, "package.json");
      const pluginManifest = join(stationPluginPath(), "plugin.json");
      const prismOk = existsSync(prismPackage);
      const pluginOk = existsSync(pluginManifest);

      if (prismOk && pluginOk) {
        return {
          id: "prism",
          label: "Prism",
          status: "ok",
          detail: "local Prism package and station plugin manifest found",
          metadata: {
            prismRoot: PRISM_ROOT,
            stationPluginPath: stationPluginPath(),
          },
        };
      }

      return {
        id: "prism",
        label: "Prism",
        status: "warning",
        detail: "Prism root or station plugin manifest is missing",
        metadata: {
          prismRoot: PRISM_ROOT,
          stationPluginPath: stationPluginPath(),
        },
      };
    }),
    dryRunCodexCompile: Effect.tryPromise({
      // Resolve the spawn env first so `bun` resolves on the PATH floor even
      // under a packaged/launchd launch; runProcess inherits the mutated
      // process.env.PATH that resolvedSpawnEnv() sets.
      try: async () => {
        await resolvedSpawnEnv();
        return runProcess(
          "bun",
          [
            "src/cli.ts",
            "install",
            stationPluginPath(),
            "--harness",
            "codex-cli",
            "--scope",
            "project",
            "--project",
            compiledHarnessProjectPath(),
            "--dry-run",
            "--no-validate",
          ],
          { cwd: PRISM_ROOT, timeoutMs: 12_000 },
        );
      },
      catch: (error) =>
        new PrismError({
          message: error instanceof Error ? error.message : String(error),
        }),
    }).pipe(
      Effect.map((result): ServiceCheck => ({
        id: "prism-compile",
        label: "Prism Compile",
        status: result.code === 0 ? "ok" : "error",
        detail:
          result.code === 0
            ? "codex-cli dry-run compile completed"
            : result.stderr.trim() || `prism exited with code ${result.code}`,
        metadata: {
          compiledProjectPath: compiledHarnessProjectPath(),
          stdout: result.stdout.slice(-1_200),
        },
      })),
    ),
  }),
);
