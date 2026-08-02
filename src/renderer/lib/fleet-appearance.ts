import { Effect, Queue } from "effect";
import type { RemoteHost } from "@shared/remote-hosts";
import { refreshFleet } from "./fleet-state";
import { state$ } from "./state";
import { getVellumApi } from "./vellum-api";

type FleetAppearance = NonNullable<RemoteHost["appearance"]>;

interface AppearanceCommand {
  readonly host: RemoteHost;
  readonly appearance: FleetAppearance;
  readonly revision: number;
  readonly onError?: (message: string) => void;
}

const queue = Effect.runSync(Queue.unbounded<AppearanceCommand>());
const latestRevision = new Map<string, number>();
let revision = 0;

const persistAppearance = Effect.fn("fleet.persistAppearance")(function* (
  command: AppearanceCommand,
) {
  if (latestRevision.get(command.host.id) !== command.revision) return;
  const api = getVellumApi();
  if (!api?.hostsUpsert) {
    return yield* Effect.fail(new Error("Host appearance API unavailable"));
  }

  const result = yield* Effect.tryPromise({
    try: () => api.hostsUpsert({ ...command.host, appearance: command.appearance }),
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(String(cause)),
  });
  if (!result.ok) {
    return yield* Effect.fail(
      new Error(result.message ?? "Could not save station appearance"),
    );
  }
});

Effect.runFork(
  Queue.take(queue).pipe(
    Effect.flatMap((command) =>
      persistAppearance(command).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            if (latestRevision.get(command.host.id) !== command.revision) return;
            command.onError?.(error.message);
            void refreshFleet();
          }),
        ),
      ),
    ),
    Effect.forever,
  ),
);

/**
 * Apply presentation immediately, then serialize durable host-registry writes.
 * Older queued choices are skipped, so rapid pointer-up selection cannot race
 * a newer silhouette backward.
 */
export const setFleetAppearance = (
  host: RemoteHost,
  appearance: FleetAppearance,
  onError?: (message: string) => void,
): void => {
  const normalized: FleetAppearance = {
    ...(appearance.color === undefined ? {} : { color: appearance.color }),
    ...(appearance.glyph === undefined ? {} : { glyph: appearance.glyph }),
  };
  const nextRevision = ++revision;
  latestRevision.set(host.id, nextRevision);

  state$.fleetHosts.set(
    state$.fleetHosts
      .peek()
      .map((candidate) =>
        candidate.id === host.id ? { ...candidate, appearance: normalized } : candidate,
      ),
  );

  Effect.runFork(
    Queue.offer(queue, {
      host: { ...host, appearance: normalized },
      appearance: normalized,
      revision: nextRevision,
      onError,
    }),
  );
};
