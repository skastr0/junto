/**
 * The reads shared code asks of the core, answered where the services live:
 * on the core's own runtime. Only the core entry loads this module; main
 * installs reads that ask the core by name (core-process/main-client.ts), so
 * the model, machine and vault services never enter main's bundle.
 */
import { Effect } from "effect";
import { coreRunner, installCoreReads, type CoreReads } from "./core-runner";
import { shellEnvironment } from "./shell-environment";

const shellEnvironmentNow = (): NodeJS.ProcessEnv => shellEnvironment.environmentNow();

export const installInProcessCoreReads = (): void => {
  const reads: CoreReads = {
    canvas: async (canvasName) => {
      const { ModelService } = await import("./model/service");
      const read = await coreRunner.runPromise(
        Effect.flatMap(ModelService, (model) => model.canvas(canvasName)).pipe(Effect.result),
      );
      return read._tag === "Success" ? read.success : undefined;
    },
    machineName: async () => {
      const { MachineRepository } = await import("./machines/repository");
      return coreRunner.runPromise(
        Effect.flatMap(MachineRepository, (machine) => machine.machineName),
      );
    },
    vaultScope: async () => {
      const [{ MachineRepository }, { VaultTokens }] = await Promise.all([
        import("./machines/repository"),
        import("./vault/repository"),
      ]);
      const record = await coreRunner.runPromise(
        Effect.gen(function* () {
          const machine = yield* MachineRepository;
          const tokens = yield* VaultTokens;
          return yield* tokens.get(yield* machine.machineName);
        }),
      );
      return record === undefined ? undefined : { vault: record.vault };
    },
    // The core's own copy of the service: the one that writes the env its spawns use.
    spawnEnv: async () => {
      const { shellEnvironment } = await import("./shell-environment");
      return { ...(await shellEnvironment.ensure()) };
    },
    spawnEnvNow: () => {
      // The module is already loaded by the async read above on every spawn
      // path; the sync caller may still be the first, so take it statically.
      return { ...shellEnvironmentNow() };
    },
  };
  installCoreReads(reads);
};
