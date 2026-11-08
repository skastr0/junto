/**
 * The core's handlers of the references group (src/contract/core/references.ts):
 * the window's app briefing and references. Thin over the one store, whose
 * author is the operator: a read that cannot be answered fails the call; a
 * write that is refused answers with the reason in words. Each committed
 * change, whoever wrote it, is published on the references channel while this
 * server runs, and main forwards it to every window.
 */
import { Effect } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import { toReferenceSummary } from "@shared/references";
import { ReferencesRpcs, ReferencesUnavailable } from "../../contract/core/references";
import { onReferencesChanged } from "../references/changes";
import { ReferencesRepository, type ReferencesRepositoryError } from "../references/repository";
import { CorePushes } from "../push";

const NOT_SAVED = "that could not be saved; try again";

const unavailable = (error: ReferencesRepositoryError) => new ReferencesUnavailable({ message: error.message });

const refusal = (error: ReferencesRepositoryError): { readonly ok: false; readonly message: string } => ({
  ok: false,
  message: error._tag === "ReferenceRefused" ? error.message : NOT_SAVED,
});

export const ReferencesHandlers = ReferencesRpcs.toLayer(
  Effect.gen(function* () {
    const repository = yield* ReferencesRepository;
    const pushes = yield* CorePushes;
    // The store says so after every committed write; a push is a synchronous send on the port.
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        onReferencesChanged((event) => Effect.runSync(pushes.publish(IPC_CHANNELS.referencesChanged, event))),
      ),
      (stop) => Effect.sync(stop),
    );
    return {
      ReferencesBriefingRead: () => repository.briefingRead().pipe(Effect.mapError(unavailable)),
      ReferencesBriefingWrite: ({ body }) =>
        repository.briefingWrite(body, "operator").pipe(
          Effect.map((briefing) => ({ ok: true as const, briefing })),
          Effect.catch((error) => Effect.succeed(refusal(error))),
        ),
      ReferencesList: ({ place }) =>
        repository.list(place).pipe(
          Effect.map((stored) => stored.map(toReferenceSummary)),
          Effect.mapError(unavailable),
        ),
      ReferencesRead: ({ place, name }) => repository.read(place, name).pipe(Effect.mapError(unavailable)),
      ReferencesWrite: ({ place, name, description, body }) =>
        repository.write(place, { name, description, body }, "operator").pipe(
          Effect.map((reference) => ({ ok: true as const, reference: toReferenceSummary(reference) })),
          Effect.catch((error) => Effect.succeed(refusal(error))),
        ),
      ReferencesDelete: ({ place, name }) =>
        repository.remove(place, name).pipe(
          Effect.map((deleted) => ({ ok: true as const, deleted })),
          Effect.catch((error) => Effect.succeed(refusal(error))),
        ),
    };
  }),
);
