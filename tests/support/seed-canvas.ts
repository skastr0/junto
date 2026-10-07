import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { asCanvasName, asNodeId, type Node, type Wire } from "../../src/shared/model";
import { ModelLive } from "../../src/main/junto/model/layer";
import { ModelRecords } from "../../src/main/junto/model/records";
import { ModelService } from "../../src/main/junto/model/service";
import { WorkModelDependentsLive } from "../../src/main/junto/work/model-dependents";

// Canvases for a test, put in the model with commands as the operator would.

/** The model as the app builds it, over a state engine and the work repository. */
export const ModelStoresLive = Layer.provide(ModelLive, WorkModelDependentsLive);

/**
 * Make a canvas holding these nodes and wires. A seat is never an overseer
 * from here; grant that with `grantOverseer`. Adding to a canvas that already
 * exists adds these beside what it holds.
 */
export const seedCanvas = (
  name: string,
  nodes: ReadonlyArray<Node>,
  wires: ReadonlyArray<Wire> = [],
) =>
  Effect.gen(function* () {
    const model = yield* ModelService;
    const canvas = asCanvasName(name);
    const names = yield* model.listCanvases();
    if (!names.some((held) => held === name)) {
      yield* model.command({ _tag: "CreateCanvas", canvas }, "operator");
    }
    if (nodes.length === 0 && wires.length === 0) return;
    let top = 0;
    for (const node of (yield* model.canvas(name)).nodes.values()) top = Math.max(top, node.z + 1);
    yield* model.command(
      {
        _tag: "Add",
        canvas,
        nodes: nodes.map((node, index) => ({ ...node, z: top + index })),
        wires: [...wires],
      },
      "operator",
    );
  });

/** The operator giving or taking a seat's authority over the canvas. */
export const grantOverseer = (name: string, nodeId: string, overseer: boolean) =>
  Effect.flatMap(ModelService, (model) =>
    model.command(
      { _tag: "GrantOverseer", canvas: asCanvasName(name), id: asNodeId(nodeId), overseer },
      "operator",
    ),
  );

/** A canvas as the model holds it now. */
export const readSeeded = (name: string) =>
  Effect.flatMap(ModelService, (model) => model.canvas(name));

/**
 * Put canvases straight into the model's rows at a sequence the test names,
 * for a rig that holds the state engine and no model service. A canvas of the
 * same name is replaced.
 */
export const seedCanvasRows = Effect.fn("test.seedCanvasRows")(
  function* (input: {
    readonly seq: number;
    readonly canvases: ReadonlyMap<
      string,
      { readonly nodes: ReadonlyArray<Node>; readonly wires?: ReadonlyArray<Wire> }
    >;
  }) {
    const records = yield* ModelRecords;
    const sql = yield* SqlClient.SqlClient;
    for (const [name, held] of input.canvases) {
      if (yield* records.getCanvas(name)) yield* records.removeCanvas(name);
      yield* records.createCanvas(name, `test-${name}`);
      for (const [z, node] of held.nodes.entries()) yield* records.insertNode(name, { ...node, z });
      for (const wire of held.wires ?? []) yield* records.insertWire(name, wire);
      yield* sql`UPDATE canvases SET seq=${input.seq} WHERE canvas_name=${name}`;
    }
  },
  Effect.provide(ModelRecords.layer),
);
