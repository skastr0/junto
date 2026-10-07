import { Effect, Option } from "effect";
import type {
  OverseerArgsFor,
  OverseerCaller,
  OverseerErrorBody,
  OverseerRequest,
} from "@shared/overseer-control";
import { asNodeId } from "@shared/model/base";
import { regionName } from "@shared/model/canvas";
import { canvasFromDocument } from "@shared/model/from-document";
import {
  APP_REFERENCE_PLACE,
  referenceBytes,
  type ReferenceAuthor,
  type ReferencePlace,
  type ReferenceRegion,
  type StoredReference,
} from "@shared/references";
import { CanvasesService } from "../canvases";
import { ReferencesRepository, type ReferencesRepositoryError } from "../references/repository";

/**
 * `references.*` and `briefing.*`: an overseer reads and writes the
 * operator's texts. No `regionId` means the app-wide references; with one,
 * that region's, on `canvas` or the overseer's own canvas. The author of a
 * write is recorded as the overseer's seat.
 */
export type OverseerReferencesOutcome =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly error: OverseerErrorBody };

export const REFERENCES_STORE_MISSING = "references are not available in this build";

const refused = (
  type: OverseerErrorBody["type"],
  message: string,
  details?: unknown,
): OverseerReferencesOutcome => ({
  ok: false,
  error: { type, message, ...(details === undefined ? {} : { details }) },
});

const storeFailure = (error: ReferencesRepositoryError): OverseerReferencesOutcome =>
  error._tag === "ReferenceRefused"
    ? refused("InvalidArguments", error.message)
    : refused("InternalError", "the references store could not be reached");

type Placed = {
  readonly place: ReferencePlace;
  /** What a result says about where the reference is kept. */
  readonly where: { readonly scope: "app" } | { readonly scope: "region"; readonly canvas: string; readonly region: ReferenceRegion };
};

type PlaceArgs = { readonly canvas?: string; readonly regionId?: string };

/** The one place the arguments name. A region must exist on its canvas. */
const placeOf = (caller: OverseerCaller, args: PlaceArgs) =>
  Effect.gen(function* () {
    if (args.regionId === undefined) {
      if (args.canvas !== undefined) {
        return refused(
          "InvalidArguments",
          "canvas applies only together with regionId: an app-wide reference belongs to no canvas",
        );
      }
      return { place: APP_REFERENCE_PLACE, where: { scope: "app" } } satisfies Placed;
    }
    const canvasName = args.canvas ?? caller.canvasName;
    const canvases = yield* CanvasesService;
    const read = yield* canvases.read(canvasName, "overseer.canvas").pipe(Effect.option);
    if (Option.isNone(read)) return refused("NotFound", `canvas "${canvasName}" was not found`);
    const node = canvasFromDocument(canvasName, read.value.doc).nodes.get(asNodeId(args.regionId));
    if (node === undefined || node.kind !== "region") {
      return refused("NotFound", `region "${args.regionId}" was not found on canvas "${canvasName}"`);
    }
    return {
      place: { kind: "region", canvasName, regionId: args.regionId },
      where: { scope: "region", canvas: canvasName, region: { id: args.regionId, label: regionName(node) } },
    } satisfies Placed;
  });

const isRefusal = (value: Placed | OverseerReferencesOutcome): value is OverseerReferencesOutcome => "ok" in value;

const summary = ({ body, ...reference }: StoredReference) => ({ ...reference, bytes: referenceBytes(body) });

export const executeOverseerReferences = (
  caller: OverseerCaller,
  request: OverseerRequest,
): Effect.Effect<OverseerReferencesOutcome, never, CanvasesService> =>
  Effect.gen(function* () {
    const storeOption = yield* Effect.serviceOption(ReferencesRepository);
    if (Option.isNone(storeOption)) return refused("Unsupported", REFERENCES_STORE_MISSING);
    const store = storeOption.value;
    const author: ReferenceAuthor = `overseer:${caller.nodeId}`;
    const answer = <A>(
      effect: Effect.Effect<A, ReferencesRepositoryError>,
      data: (value: A) => OverseerReferencesOutcome,
    ) => effect.pipe(Effect.map(data), Effect.catch((error) => Effect.succeed(storeFailure(error))));

    switch (request.operation) {
      case "briefing.read":
        return yield* answer(store.briefingRead(), (briefing) => ({
          ok: true,
          data: briefing === null ? { body: null } : { body: briefing.body, updatedAt: briefing.updatedAt },
        }));
      case "briefing.write": {
        const { body } = request.args as OverseerArgsFor<"briefing.write">;
        if (body.trim().length === 0) {
          return refused("InvalidArguments", "the briefing needs a body; the operator clears it in Settings");
        }
        return yield* answer(store.briefingWrite(body, author), (briefing) => ({
          ok: true,
          data: { written: true, bytes: referenceBytes(briefing?.body ?? ""), updatedAt: briefing?.updatedAt },
        }));
      }
      case "references.list": {
        const placed = yield* placeOf(caller, request.args as OverseerArgsFor<"references.list">);
        if (isRefusal(placed)) return placed;
        return yield* answer(store.list(placed.place), (references) => ({
          ok: true,
          data: { ...placed.where, references: references.map(summary) },
        }));
      }
      case "references.read": {
        const args = request.args as OverseerArgsFor<"references.read">;
        const placed = yield* placeOf(caller, args);
        if (isRefusal(placed)) return placed;
        const found = yield* answer(store.read(placed.place, args.name), (reference): OverseerReferencesOutcome =>
          reference === null
            ? refused("NotFound", `no reference named "${args.name.trim().toLowerCase()}" here`, {
                hint: "junto overseer references list",
              })
            : { ok: true, data: { ...placed.where, ...reference } });
        return found;
      }
      case "references.write": {
        const args = request.args as OverseerArgsFor<"references.write">;
        const placed = yield* placeOf(caller, args);
        if (isRefusal(placed)) return placed;
        return yield* answer(
          store.write(placed.place, { name: args.name, description: args.description, body: args.body }, author),
          (reference) => ({ ok: true, data: { ...placed.where, ...summary(reference), written: true } }),
        );
      }
      case "references.delete": {
        const args = request.args as OverseerArgsFor<"references.delete">;
        const placed = yield* placeOf(caller, args);
        if (isRefusal(placed)) return placed;
        return yield* answer(store.remove(placed.place, args.name), (removed): OverseerReferencesOutcome =>
          removed
            ? { ok: true, data: { ...placed.where, name: args.name.trim().toLowerCase(), deleted: true } }
            : refused("NotFound", `no reference named "${args.name.trim().toLowerCase()}" here`, {
                hint: "junto overseer references list",
              }));
      }
      default:
        return refused("InternalError", `references dispatcher does not own ${request.operation}`);
    }
  });
