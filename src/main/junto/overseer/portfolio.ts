import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { CanvasDoc } from "@shared/canvas";
import { CanvasName, type Canvas, type CanvasCommand } from "@shared/model";
import { inPaintOrder } from "@shared/model/canvas";
import { documentEdits } from "@shared/model/document-edits";
import { nodeToDocument, wireToDocument } from "@shared/model/from-document";
import type { WorkErrorBody } from "@shared/work-control";
import { ModelNotFound, ModelRefused, type ModelError } from "../model/records";
import type { ModelActorRefs } from "../model/actor-refs";
import { ModelService } from "../model/service";
import { StateTransactionOperation } from "../state/service";
import type { WorkRepository } from "../work/repository";

// The overseer's document boundary.
//
// An overseer agent still reads and sends document-shaped nodes and edges
// (shared/overseer-control.ts). Main holds no document: this file shows the
// model's canvases as documents for the overseer's rules to read, and turns
// what a rule says the documents should become into model commands sent with
// source "overseer". The model is the authority that accepts or refuses them.
//
// TEMPORARY. It goes when the overseer wire speaks model kinds (node.create
// by kind, node.configure as an edit, reads returning nodes and wires); the
// rules are then written over commands and nothing here is left.

export type OverseerStores =
  | ModelService
  | ModelActorRefs
  | SqlClient.SqlClient
  | WorkRepository;

export type OverseerPortfolioView = {
  readonly documents: ReadonlyMap<string, CanvasDoc>;
  /** The canvas sequence, as the revision an overseer reads and sends back. */
  readonly revisions: ReadonlyMap<string, string>;
};

const held = new WeakMap<Canvas, CanvasDoc>();

/** The structure of a canvas as a document. A canvas holds no work. */
export const documentOfCanvas = (canvas: Canvas): CanvasDoc => {
  const known = held.get(canvas);
  if (known !== undefined) return known;
  const doc: CanvasDoc = {
    nodes: inPaintOrder(canvas).map(nodeToDocument),
    edges: [...canvas.wires.values()].map(wireToDocument),
  };
  held.set(canvas, doc);
  return doc;
};

export const revisionOf = (canvas: Canvas): string => String(canvas.seq);

export const fromModelError = (error: ModelError): WorkErrorBody => {
  if (error instanceof ModelNotFound) {
    return {
      type: "UnknownTarget",
      message: `${error.what} "${error.id}" does not exist`,
    };
  }
  if (error instanceof ModelRefused) {
    // The model's one rule about authority names the overseer seat; every
    // other refusal is about what was sent.
    return {
      type: /overseer/iu.test(error.rule) ? "AuthError" : "InputError",
      message: error.rule,
    };
  }
  return { type: "InternalError", message: "the canvas store could not be read or written" };
};

export const isCanvasName = Schema.is(CanvasName);

/** The name as the model takes it, or the refusal an overseer is told. */
export const canvasNameOf = (
  raw: string,
): Effect.Effect<CanvasName, WorkErrorBody> =>
  isCanvasName(raw)
    ? Effect.succeed(raw)
    : Effect.fail({
        type: "InputError",
        message: `invalid canvas name ${JSON.stringify(raw)}`,
      });

const readCanvases = Effect.gen(function* () {
  const model = yield* ModelService;
  const canvases = new Map<string, Canvas>();
  for (const name of yield* model.listCanvases()) {
    canvases.set(name, yield* model.canvas(name));
  }
  return canvases;
});

const viewOf = (canvases: ReadonlyMap<string, Canvas>): OverseerPortfolioView => ({
  documents: new Map(
    [...canvases].map(([name, canvas]) => [name, documentOfCanvas(canvas)]),
  ),
  revisions: new Map(
    [...canvases].map(([name, canvas]) => [name, revisionOf(canvas)]),
  ),
});

/** Every canvas as the model holds it now, as documents. */
export const readPortfolio: Effect.Effect<
  OverseerPortfolioView,
  WorkErrorBody,
  ModelService
> = readCanvases.pipe(Effect.map(viewOf), Effect.mapError(fromModelError));

/** One canvas, by the name an overseer gave. */
export const readCanvasDocument = (
  raw: string,
): Effect.Effect<
  { readonly name: string; readonly doc: CanvasDoc; readonly revision: string },
  WorkErrorBody,
  ModelService
> =>
  Effect.gen(function* () {
    const name = yield* canvasNameOf(raw);
    const model = yield* ModelService;
    const canvas = yield* model.canvas(name).pipe(Effect.mapError(fromModelError));
    return { name, doc: documentOfCanvas(canvas), revision: revisionOf(canvas) };
  });

export type OverseerPortfolioEdit<A> =
  | {
      readonly ok: true;
      readonly documents: ReadonlyMap<string, CanvasDoc>;
      readonly result: A;
    }
  | { readonly ok: false; readonly error: WorkErrorBody };

/** Where the next node added to a canvas stacks: above everything on it. */
const topOf = (canvas: Canvas | undefined): number => {
  let top = 0;
  for (const node of canvas?.nodes.values() ?? []) top = Math.max(top, node.z + 1);
  return top;
};

const NO_DOCUMENT: CanvasDoc = { nodes: [], edges: [] };

/**
 * Read every canvas, let a rule say what the documents should become, and
 * send the difference, all in one transaction: the rule decides on exactly
 * what is committed against, and either every canvas it changed moves or none
 * does. A canvas the rule added is created; one it dropped is removed.
 */
export const editPortfolio = <A>(
  rule: (view: OverseerPortfolioView) => OverseerPortfolioEdit<A>,
): Effect.Effect<A, WorkErrorBody, OverseerStores> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const model = yield* ModelService;
    const send = (command: Parameters<typeof model.command>[0]) =>
      model.command(command, "overseer").pipe(Effect.mapError(fromModelError));
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const canvases = yield* readCanvases.pipe(Effect.mapError(fromModelError));
          const view = viewOf(canvases);
          const edit = rule(view);
          if (!edit.ok) return yield* Effect.fail(edit.error);

          for (const name of view.documents.keys()) {
            if (edit.documents.has(name)) continue;
            yield* send({ _tag: "RemoveCanvas", canvas: yield* canvasNameOf(name) });
          }
          for (const [name, after] of edit.documents) {
            const before = view.documents.get(name);
            if (before === after) continue;
            const canvas = yield* canvasNameOf(name);
            if (before === undefined) yield* send({ _tag: "CreateCanvas", canvas });
            const steps = documentEdits(
              name,
              before ?? NO_DOCUMENT,
              after,
              topOf(canvases.get(name)),
            ) as ReadonlyArray<CanvasCommand>;
            if (steps.length > 0) yield* send({ _tag: "Batch", canvas, steps });
          }
          return edit.result;
        }),
      )
      .pipe(
        // The name a live request's receipt is recorded under (live/service.ts
        // afterMutation): this is the transaction that owns an overseer write.
        Effect.provideService(StateTransactionOperation, "canvas.mutatePortfolio"),
        Effect.mapError((error): WorkErrorBody =>
          // A rule's refusal and a model refusal are already what an overseer
          // is told. Anything else came from a participant in the transaction
          // (a live request's fence, the store itself) and keeps its words.
          typeof error === "object" && error !== null && "type" in error && "message" in error
            ? (error as WorkErrorBody)
            : {
                type: "InternalError",
                message:
                  error instanceof Error
                    ? error.message
                    : "the canvas store could not be written",
              },
        ),
      );
  });
