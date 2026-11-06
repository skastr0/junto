/**
 * The spawn environment, apart from the adapter plane: both processes read it,
 * and only the core spawns adapter children (./exec), so main links this and
 * never the adapter operation registry.
 */
import { coreReads } from "../../core-runner";

// The PATH floor is shared and pure (@shared/spawn-path); the operator's shell
// environment itself lives with the core (../shell-environment), which reads
// it once per app start and again on request. Any failure is fail-open: the
// spawn PATH is then the inherited PATH, operator tool directories and the
// static floor.
export { staticPathDirs, mergePath } from "@shared/spawn-path";

// The one resolved environment every spawn call-site should use: the core's
// shell read, the operator's shell environment with PATH merged over the
// inherited PATH, operator tool directories and the static floor. Main asks
// the core for it and holds no copy of its own.
//
// Seats, terminals, the codex/prism service spawns, SSH and runCli below all
// route through here, so a packaged/launchd launch runs CLIs with the same
// environment as a dev-from-terminal launch.
//
// SINGLE documented mutation of the app's own environment: the module assigns
// the shell's variables and the merged PATH onto process.env, so any spawn
// that inherits process.env verbatim (seat launches, the services/process.ts
// helper) carries the operator environment for free. Shell bookkeeping keys
// and the app's own JUNTO_*/ELECTRON_* keys are never taken from the shell.
export const resolvedSpawnEnv = (): Promise<NodeJS.ProcessEnv> => coreReads.spawnEnv();

// Synchronous accessor for call-sites that cannot await (e.g. inside a spawn
// options literal). In the core it is the environment its shell read applied;
// in main, which holds no shell environment, it is the inherited PATH merged
// with the floor, so a synchronous caller never ships the bare minimal PATH.
export const resolvedSpawnEnvSync = (): NodeJS.ProcessEnv => coreReads.spawnEnvNow();
