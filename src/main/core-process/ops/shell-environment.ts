/**
 * The shell environment, answered where the spawns are. The core's own copy of
 * the service is the one that writes process.env for every harness launch, so
 * the status the window shows, the operator's refresh and the change push all
 * come from here; main relays and keeps no instance.
 */
import { Effect } from "effect";
import type { ShellEnvironmentStatus } from "@shared/shell-environment";
import { shellEnvironment } from "../../junto/shell-environment";
import { SHELL_ENVIRONMENT_CHANGED } from "../channels";
import { publish } from "../push";
import { coreOps, type CoreOp } from "../ops";

declare module "../ops" {
  interface CoreOps {
    "ipc.shellEnvironment.status": CoreOp<Record<string, never>, ShellEnvironmentStatus>;
    "ipc.shellEnvironment.refresh": CoreOp<Record<string, never>, ShellEnvironmentStatus>;
  }
}

// The copy that spawns is the one whose changes the window shows.
shellEnvironment.onChange((change) => publish(SHELL_ENVIRONMENT_CHANGED, change));

coreOps({
  "ipc.shellEnvironment.status": () => Effect.promise(() => shellEnvironment.status()),
  // The operator asked for a fresh read: the next spawn uses it.
  "ipc.shellEnvironment.refresh": () => Effect.promise(() => shellEnvironment.refresh("operator")),
});
