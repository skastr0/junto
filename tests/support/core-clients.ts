/**
 * Main's clients of the core, built on a link nothing answers: for tests that
 * register main's IPC and never ask the core.
 */
import { Effect, Layer, Scope } from "effect";
import { CoreLink } from "../../src/contract/core/link";
import { CoreClientsLive } from "../../src/app/core-process/clients";

export const unansweredCoreClients = () =>
  Effect.runPromise(
    Effect.flatMap(Scope.make(), (scope) =>
      Layer.buildWithScope(
        CoreClientsLive.pipe(Layer.provide(Layer.succeed(CoreLink, { post: () => undefined, listen: () => () => undefined }))),
        scope,
      ),
    ),
  );
