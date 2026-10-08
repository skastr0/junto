import { Effect } from "effect";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync, realpathSync } from "node:fs";
import { makeStateEngineLive, StateEngine } from "../src/main/junto/state/engine";

// This loads the database owner only, never AppRuntime, Electron, PTYs or timers.
const home = resolve(process.env.JUNTO_HOME ?? join(homedir(), ".junto-preview-copy"));
const path = join(home, ".junto", "state", "junto.db");
if (!existsSync(path) || realpathSync(path) === realpathSync(join(homedir(), ".junto", "state", "junto.db"))) throw new Error("Migration requires an existing preview copy, separate from production");
process.env.JUNTO_HOME = home;
const info = await Effect.runPromise(Effect.gen(function* () {
  return (yield* StateEngine).info;
}).pipe(Effect.provide(makeStateEngineLive(path))));
console.log(JSON.stringify(info, null, 2));
