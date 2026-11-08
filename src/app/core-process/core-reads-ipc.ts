/**
 * Main's reads of the core's own reads (src/contract/core/core-reads.ts): this
 * machine's name, for local browser admission. The read is the same one the
 * Files service makes in the core (core/files/host-deps.ts): ask the core, and
 * fail closed, as `undefined`, when it cannot answer.
 */
import { Context } from "effect";
import { CoreReadsCore } from "../../contract/core/core-reads";
import { AppRuntime } from "../runtime";

export const coreMachineName = (core: Context.Context<CoreReadsCore>): (() => Promise<string | undefined>) => {
  const reads = Context.get(core, CoreReadsCore);
  return () => AppRuntime.runPromise(reads.CoreReadsMachineName()).catch(() => undefined);
};
