/**
 * The window's app briefing and references (junto/references/ipc.ts). Thin
 * over the one store, whose author is the operator: a read that cannot be
 * answered fails the call; a write that is refused answers with the reason in
 * words. Each committed change is published on the references channel, which
 * main forwards to every window.
 */
import { Effect } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import {
  APP_REFERENCE_PLACE,
  toReferenceSummary,
  type AppBriefing,
  type AppBriefingWriteResult,
  type ReferenceDeleteResult,
  type ReferencePlace,
  type ReferenceSummary,
  type ReferenceWriteResult,
  type StoredReference,
} from "@shared/references";
import { onReferencesChanged } from "../../junto/references/changes";
import { ReferencesRepository, type ReferencesRepositoryError } from "../../junto/references/repository";
import { publish } from "../push";
import { coreOps, type CoreOp } from "../ops";

declare module "../ops" {
  interface CoreOps {
    "ipc.references.briefingRead": CoreOp<Record<string, never>, AppBriefing | null>;
    "ipc.references.briefingWrite": CoreOp<{ readonly input: unknown }, AppBriefingWriteResult>;
    "ipc.references.list": CoreOp<{ readonly input: unknown }, ReadonlyArray<ReferenceSummary>>;
    "ipc.references.read": CoreOp<{ readonly input: unknown }, StoredReference | null>;
    "ipc.references.write": CoreOp<{ readonly input: unknown }, ReferenceWriteResult>;
    "ipc.references.delete": CoreOp<{ readonly input: unknown }, ReferenceDeleteResult>;
    "ipc.references.watch": CoreOp<Record<string, never>, void>;
  }
}

const NOT_SAVED = "that could not be saved; try again";

const record = (input: unknown): Record<string, unknown> =>
  typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};

type Placed = { readonly ok: true; readonly place: ReferencePlace } | { readonly ok: false; readonly message: string };

/** Nothing is the app; a canvas and a region together are that region. */
const placeOf = (input: unknown): Placed => {
  const { canvasName, regionId } = record(input);
  if (canvasName === undefined && regionId === undefined) return { ok: true, place: APP_REFERENCE_PLACE };
  if (typeof canvasName === "string" && canvasName.length > 0 && typeof regionId === "string" && regionId.length > 0) {
    return { ok: true, place: { kind: "region", canvasName, regionId } };
  }
  return { ok: false, message: "a region's reference needs both its canvas and its region" };
};

const refusal = (error: ReferencesRepositoryError): { readonly ok: false; readonly message: string } => ({
  ok: false,
  message: error._tag === "ReferenceRefused" ? error.message : NOT_SAVED,
});

const placedOrFail = (input: unknown): Effect.Effect<ReferencePlace, Error> =>
  Effect.suspend(() => {
    const placed = placeOf(input);
    return placed.ok ? Effect.succeed(placed.place) : Effect.fail(new Error(placed.message));
  });

type Repository = ReferencesRepository["Service"];

const settled = <A extends { readonly ok: true }>(
  repository: Repository,
  use: (repository: Repository) => Effect.Effect<A, ReferencesRepositoryError>,
): Effect.Effect<A | { readonly ok: false; readonly message: string }> =>
  use(repository).pipe(Effect.catch((error) => Effect.succeed(refusal(error))));

let watching = false;

coreOps({
  "ipc.references.briefingRead": () =>
    Effect.flatMap(ReferencesRepository, (repository) => repository.briefingRead()),
  "ipc.references.briefingWrite": ({ input }) =>
    typeof input !== "string"
      ? Effect.succeed({ ok: false as const, message: "the briefing must be text" })
      : Effect.gen(function* () {
          const repository = yield* ReferencesRepository;
          return yield* settled(repository, (store) =>
            store.briefingWrite(input, "operator").pipe(Effect.map((briefing) => ({ ok: true as const, briefing }))),
          );
        }),
  "ipc.references.list": ({ input }) =>
    Effect.gen(function* () {
      const place = yield* placedOrFail(input);
      const stored = yield* Effect.flatMap(ReferencesRepository, (repository) => repository.list(place));
      return stored.map(toReferenceSummary);
    }),
  "ipc.references.read": ({ input }) =>
    Effect.gen(function* () {
      const place = yield* placedOrFail(input);
      return yield* Effect.flatMap(ReferencesRepository, (repository) => repository.read(place, record(input).name));
    }),
  "ipc.references.write": ({ input }) =>
    Effect.gen(function* () {
      const placed = placeOf(input);
      if (!placed.ok) return placed;
      const { name, description, body } = record(input);
      const repository = yield* ReferencesRepository;
      return yield* settled(repository, (store) =>
        store
          .write(placed.place, { name, description, body }, "operator")
          .pipe(Effect.map((reference) => ({ ok: true as const, reference: toReferenceSummary(reference) }))),
      );
    }),
  "ipc.references.delete": ({ input }) =>
    Effect.gen(function* () {
      const placed = placeOf(input);
      if (!placed.ok) return placed;
      const repository = yield* ReferencesRepository;
      return yield* settled(repository, (store) =>
        store.remove(placed.place, record(input).name).pipe(Effect.map((deleted) => ({ ok: true as const, deleted }))),
      );
    }),
  "ipc.references.watch": () =>
    Effect.sync(() => {
      if (watching) return;
      watching = true;
      onReferencesChanged((event) => publish(IPC_CHANNELS.referencesChanged, event));
    }),
});
