/**
 * Main's clients of the core, built on a link nothing answers, with a push
 * bus nothing feeds: for tests that register main's IPC and never ask the core.
 */
import { Context, Effect, Layer, Scope } from "effect";
import { CoreLink } from "../../src/contract/core/link";
import { CoreClientsLive, type CoreClients } from "../../src/app/core-process/clients";
import { CorePushesMain, makeCorePushesMain } from "../../src/app/core-process/main-side/core-pushes";

export const unansweredCoreClients = (): Promise<Context.Context<CoreClients>> =>
  Effect.runPromise(
    Effect.flatMap(Scope.make(), (scope) =>
      Effect.gen(function* () {
        const clients = yield* Layer.buildWithScope(
          CoreClientsLive.pipe(Layer.provide(Layer.succeed(CoreLink, { post: () => undefined, listen: () => () => undefined }))),
          scope,
        );
        const { pushes } = yield* Scope.provide(makeCorePushesMain, scope);
        return Context.add(clients, CorePushesMain, pushes);
      }),
    ),
  );
