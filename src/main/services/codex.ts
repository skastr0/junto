import { Context, Effect, Layer, Schema } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import { resolvedSpawnEnv } from "../junto/adapters/exec";
import { runProcess } from "./process";

export class CodexError extends Schema.TaggedError<CodexError>()("CodexError", {
  message: Schema.String,
}) {}

/**
 * effect-foundation **S4-rest-main** (staged, not half-migrated):
 * - Canonical id: `@chassis/CodexService` — single definition; no dual path.
 * - Service id: Context.Service (Effect V4 live).
 * - Shape:
 *   `class CodexService extends Context.Service<CodexService, CodexService>()("@chassis/CodexService") {}`
 * - Layer today: CodexLive — V4 rename candidate CodexService.layer
 *   Do not dual-export Live + `.layer` names.
 */
export class CodexService extends Context.Service<CodexService,
  {
    readonly doctor: Effect.Effect<ServiceCheck>;
  }>()("@chassis/CodexService") {}

const checkCodexCli = Effect.tryPromise({
  // Resolve the spawn env first so `codex` resolves on the PATH floor even
  // under a packaged/launchd launch; runProcess inherits the mutated
  // process.env.PATH that resolvedSpawnEnv() sets.
  try: async () => {
    await resolvedSpawnEnv();
    return runProcess("codex", ["--version"], { timeoutMs: 3_000 });
  },
  catch: (error) =>
    new CodexError({
      message: error instanceof Error ? error.message : String(error),
    }),
});

export const CodexLive = Layer.succeed(
  CodexService,
  CodexService.of({
    doctor: checkCodexCli.pipe(
      Effect.map((result): ServiceCheck => {
        if (result.code === 0) {
          return {
            id: "codex",
            label: "Codex CLI",
            status: "ok",
            detail: result.stdout.trim() || "codex is available",
          };
        }

        return {
          id: "codex",
          label: "Codex CLI",
          status: "warning",
          detail: result.stderr.trim() || `codex exited with code ${result.code}`,
        };
      }),
      Effect.catch((error) =>
        Effect.succeed({
          id: "codex",
          label: "Codex CLI",
          status: "warning",
          detail: error.message,
        } satisfies ServiceCheck),
      ),
    ),
  }),
);
