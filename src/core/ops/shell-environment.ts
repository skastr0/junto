/**
 * The shell environment, answered where the spawns are (the shell environment
 * group, src/contract/core/shell-environment.ts). The core's own copy of the
 * service is the one that writes process.env for every harness launch, so the
 * status the window shows, the operator's refresh and the change push all
 * come from here; main relays and keeps no instance.
 */
import { Effect } from "effect";
import { SHELL_ENVIRONMENT_CHANGED } from "../../contract/core/channels";
import { ShellEnvironmentRpcs } from "../../contract/core/shell-environment";
import { CorePushes } from "../push";
import { shellEnvironment } from "../shell-environment";

export const ShellEnvironmentHandlers = ShellEnvironmentRpcs.toLayer(
  Effect.gen(function* () {
    const pushes = yield* CorePushes;
    // The copy that spawns is the one whose changes the window shows, for as
    // long as the server answers.
    yield* Effect.acquireRelease(
      Effect.sync(() => shellEnvironment.onChange((change) => Effect.runSync(pushes.publish(SHELL_ENVIRONMENT_CHANGED, change)))),
      (stop) => Effect.sync(stop),
    );
    return {
      ShellEnvironmentStatus: () => Effect.promise(() => shellEnvironment.status()),
      ShellEnvironmentRefresh: () => Effect.promise(() => shellEnvironment.refresh("operator")),
    };
  }),
);

/** The environment a spawn uses now, resolved here where the spawns are. */
export const spawnEnvironment: Effect.Effect<Record<string, string | undefined>> = Effect.promise(async () => ({
  ...(await shellEnvironment.ensure()),
}));
