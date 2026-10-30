/**
 * A core client for tests. Electron main installs the core process's client
 * at boot and runs no operation body itself, so a test that exercises a core
 * operation installs this one with `useCoreClient`: it runs the registered
 * bodies on the runner the test gives it, in this process.
 */
import { Effect, Exit } from "effect";
import { CoreCallError, coreFailureOf, type CoreClient, type CoreRunner } from "../../src/main/core-process/client";
import { coreOpBody } from "../../src/main/core-process/ops";
import "../../src/main/core-process/ops/index";

export type { CoreClient, CoreRunner };

export const inProcessCore = (runner: CoreRunner): CoreClient => ({
  call: async (name, input) => {
    const body = coreOpBody(name);
    if (body === undefined) throw new CoreCallError(name, "UnknownCoreOp", `no core operation named ${name}`);
    const exit = await runner.runPromiseExit(Effect.suspend(() => body(input as never)));
    if (Exit.isSuccess(exit)) return exit.value as never;
    const failure = coreFailureOf(exit.cause);
    throw new CoreCallError(name, failure.tag, failure.message);
  },
});
