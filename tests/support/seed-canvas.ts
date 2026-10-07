import { Effect, Layer } from "effect";
import type { CanvasDoc } from "../../src/shared/canvas";
import { asCanvasName, asNodeId, type CanvasCommand } from "../../src/shared/model";
import { documentEdits } from "../../src/shared/model/document-edits";
import { ModelLive } from "../../src/main/junto/model/layer";
import { ModelService } from "../../src/main/junto/model/service";
import { documentOfCanvas, revisionOf } from "../../src/main/junto/overseer/portfolio";
import { WorkModelDependentsLive } from "../../src/main/junto/work/model-dependents";

// Canvases for a test that describes them as documents. They are put in the
// model with commands, as the operator would, and read back as the overseer
// reads them. No canvas service is involved.

/** The model as the app builds it, over a state engine and the work repository. */
export const ModelStoresLive = Layer.provide(ModelLive, WorkModelDependentsLive);

const EMPTY: CanvasDoc = { nodes: [], edges: [] };

/**
 * Make the canvas hold what the document describes: created when it is not
 * there, changed to match when it is. A seat is never an overseer from a
 * document; grant that with `grantOverseer`.
 */
export const seedCanvas = (name: string, doc: CanvasDoc) =>
  Effect.gen(function* () {
    const model = yield* ModelService;
    const canvas = asCanvasName(name);
    const names = yield* model.listCanvases();
    if (!names.some((held) => held === name)) {
      yield* model.command({ _tag: "CreateCanvas", canvas }, "operator");
    }
    const held = yield* model.canvas(name);
    let top = 0;
    for (const node of held.nodes.values()) top = Math.max(top, node.z + 1);
    const before = held.nodes.size === 0 && held.wires.size === 0 ? EMPTY : documentOfCanvas(held);
    const steps = documentEdits(name, before, doc, top) as ReadonlyArray<CanvasCommand>;
    if (steps.length > 0) {
      yield* model.command({ _tag: "Batch", canvas, steps }, "operator");
    }
  });

/** The operator giving or taking a seat's authority over the canvas. */
export const grantOverseer = (name: string, nodeId: string, overseer: boolean) =>
  Effect.flatMap(ModelService, (model) =>
    model.command(
      { _tag: "GrantOverseer", canvas: asCanvasName(name), id: asNodeId(nodeId), overseer },
      "operator",
    ),
  );

/** A canvas as an overseer reads it: structure as a document, and its revision. */
export const readSeeded = (name: string) =>
  Effect.map(
    Effect.flatMap(ModelService, (model) => model.canvas(name)),
    (canvas) => ({ name, doc: documentOfCanvas(canvas), revision: revisionOf(canvas) }),
  );
