/**
 * Main's handlers of the window's shell environment group
 * (src/contract/window/shell-environment.ts). Onboarding and Settings read
 * what the core took from the shell, and ask for a fresh read there: the
 * core's copy is the one that writes the environment its spawns use, so both
 * calls go to the core's group as they are, and its change notices reach the
 * window as they come. Main keeps no copy.
 */
import { Effect } from "effect";
import { SHELL_ENVIRONMENT_CHANGED } from "../../contract/core/channels";
import { ShellEnvironmentCore, ShellEnvironmentRpcs } from "../../contract/core/shell-environment";
import { ShellEnvironmentWindowRpcs } from "../../contract/window/shell-environment";
import { forwardTo, pushes } from "../window/ipc";

export const ShellEnvironmentWindowHandlers = ShellEnvironmentWindowRpcs.toLayer(
  Effect.gen(function* () {
    const shellEnvironment = yield* ShellEnvironmentCore;
    return {
      ...forwardTo(ShellEnvironmentRpcs, shellEnvironment),
      ShellEnvironmentChanges: () => pushes(SHELL_ENVIRONMENT_CHANGED),
    };
  }),
);
