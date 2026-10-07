import { Effect, Option, Result, Schema } from "effect";
import type { CanvasDoc } from "@shared/canvas";
import { asNodeId } from "@shared/model/base";
import { regionName, regionStack } from "@shared/model/canvas";
import { canvasFromDocument } from "@shared/model/from-document";
import {
  APP_REFERENCE_PLACE,
  referencesInScope,
  toReferenceListEntry,
  toReferenceListing,
  toReferenceReadResult,
  type ReferenceListing,
  type ScopedReference,
} from "@shared/references";
import { ReferencesListArgs, ReferencesReadArgs, type WorkErrorBody } from "@shared/work-control";
import { ReferencesRepository, type ReferencesRepositoryError } from "./repository";

/**
 * What a seat reads of the operator's texts: the app briefing at onboard, and
 * the references in its scope, listed at onboard and read on demand.
 *
 * Seat-local like `env.report`: no edge, no port, and the seat is the
 * process-bound caller, never an argument. A seat's scope is the app plus
 * every region that contains it, by the one membership rule (`regionStack`).
 */
export type ReferenceSeat = {
  readonly doc: CanvasDoc;
  readonly canvasName: string;
  readonly nodeId: string;
};

/** Everything this seat can read, outer to inner, the inner name winning. */
export const seatReferences = (
  seat: ReferenceSeat,
): Effect.Effect<ReadonlyArray<ScopedReference>, ReferencesRepositoryError, ReferencesRepository> =>
  Effect.gen(function* () {
    const store = yield* ReferencesRepository;
    const regions = regionStack(canvasFromDocument(seat.canvasName, seat.doc), asNodeId(seat.nodeId)).map(
      (region) => ({ id: region.id as string, label: regionName(region) }),
    );
    const app = yield* store.list(APP_REFERENCE_PLACE);
    const regional = yield* store.regionTexts(seat.canvasName, regions.map((region) => region.id));
    return referencesInScope({ app, regions, regional });
  });

/**
 * The two fields `junto onboard` gains, each left out when empty. A runtime
 * without the store, or a store that cannot answer, leaves them out rather
 * than failing onboard.
 */
export const onboardReferenceFields = (
  seat: ReferenceSeat,
): Effect.Effect<{ readonly briefing?: string; readonly references?: ReadonlyArray<ReferenceListing> }> =>
  Effect.gen(function* () {
    const store = yield* Effect.serviceOption(ReferencesRepository);
    if (Option.isNone(store)) return {};
    const briefing = yield* store.value.briefingRead().pipe(Effect.orElseSucceed(() => null));
    const references = yield* seatReferences(seat).pipe(
      Effect.provideService(ReferencesRepository, store.value),
      Effect.orElseSucceed((): ReadonlyArray<ScopedReference> => []),
    );
    return {
      ...(briefing !== null ? { briefing: briefing.body } : {}),
      ...(references.length > 0 ? { references: references.map(toReferenceListing) } : {}),
    };
  });

const LIST_STEP = "run junto references list to see the references this seat can read";

const refusal = (error: ReferencesRepositoryError): WorkErrorBody =>
  error._tag === "ReferenceRefused"
    ? { type: "InputError", message: error.message, details: { path: "args.name", retryable: false, next_step: LIST_STEP } }
    : { type: "RuntimeDown", message: "the references could not be read", details: { retryable: true } };

const invalid = (schemaId: string) => (error: Schema.SchemaError): WorkErrorBody => ({
  type: "InputError",
  message: error.message,
  details: { path: "args", retryable: false, hint: `junto schema show ${schemaId}` },
});

/** Work ops `references.list` and `references.read`. */
export const handleSeatReferences = (
  op: "references.list" | "references.read",
  args: unknown,
  seat: ReferenceSeat,
): Effect.Effect<unknown, WorkErrorBody> =>
  Effect.gen(function* () {
    const store = yield* Effect.serviceOption(ReferencesRepository);
    if (Option.isNone(store)) {
      return yield* Effect.fail<WorkErrorBody>({
        type: "RuntimeDown",
        message: "references are not available in this runtime",
        details: { retryable: false },
      });
    }
    const inScope = seatReferences(seat).pipe(
      Effect.provideService(ReferencesRepository, store.value),
      Effect.mapError(refusal),
    );
    if (op === "references.list") {
      const decoded = Schema.decodeUnknownResult(ReferencesListArgs)(args ?? {});
      if (Result.isFailure(decoded)) return yield* Effect.fail(invalid("references.list")(decoded.failure));
      // An empty struct admits any object, so the no-argument rule is checked here.
      if (Object.keys(decoded.success).length > 0 || Object.keys((args ?? {}) as object).length > 0) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "InputError",
          message: "references list takes no arguments: a seat lists its own scope",
          details: { path: "args", retryable: false, hint: "junto schema show references.list" },
        });
      }
      return { references: (yield* inScope).map(toReferenceListEntry) };
    }
    const decoded = Schema.decodeUnknownResult(ReferencesReadArgs)(args ?? {});
    if (Result.isFailure(decoded)) return yield* Effect.fail(invalid("references.read")(decoded.failure));
    const wanted = decoded.success.name.trim().toLowerCase();
    const references = yield* inScope;
    const found = references.find((reference) => reference.name === wanted);
    if (found === undefined) {
      const names = references.map((reference) => reference.name);
      return yield* Effect.fail<WorkErrorBody>({
        type: "UnknownTarget",
        message: `no reference named "${wanted}" is in this seat's scope`,
        details: {
          target: wanted,
          retryable: false,
          hint: names.length > 0 ? `in scope: ${names.join(", ")}` : "this seat has no references in scope",
          next_step: LIST_STEP,
        },
      });
    }
    return toReferenceReadResult(found);
  });
