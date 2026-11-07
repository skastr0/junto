/**
 * The core's handlers of the core-reads group (src/contract/core/core-reads.ts):
 * the one read main asks of `coreReads` (core-runner.ts), this machine's name.
 * The canvas and the vault scope are read in this process by the code that
 * needs them, through `coreReads` itself.
 */
import { Effect } from "effect";
import { CoreReadsRpcs } from "../../contract/core/core-reads";
import { coreReads } from "../core-runner";

export const CoreReadsHandlers = CoreReadsRpcs.toLayer({
  CoreReadsMachineName: () => Effect.promise(() => coreReads.machineName()),
});
