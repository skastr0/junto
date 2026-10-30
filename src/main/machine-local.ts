// The machine bundle's Node entry for what runs on a machine's own files
// (hosts/machine-local.ts), bundled to core/machine-local.cjs.
import { Effect } from "effect";
import { machineLocal } from "./junto/hosts/machine-local";

void Effect.runPromise(machineLocal(process.argv.slice(2)));
