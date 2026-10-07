import { Effect } from "effect";
import { serializeCanvas, type CanvasDoc } from "../../src/shared/canvas";
import {
  canvasBodySha256Of,
  intentSha256Of,
} from "../../src/main/junto/canvas-intent-identity";
import type {
  CanvasIntentMaterial,
  StoredCanvasIntentDocument as CanvasAuthorityStoredDocument,
} from "../../src/main/junto/canvas-intent-identity";
type CanvasAuthorityMaterialSnapshot = CanvasIntentMaterial & { readonly generation: string };
import { ModelRecords } from "../../src/main/junto/model/records";
import { canvasFromDocument } from "../../src/shared/model/from-document";
import { SqlClient } from "effect/unstable/sql";

/** Seed current per-kind rows from a test topology, without old canvas tables. */
export const seedCanvasAuthority = Effect.fn("test.seedCanvasAuthority")(
  function* (input: {
    readonly generation: string;
    readonly documents: ReadonlyMap<string, CanvasDoc>;
    readonly at?: string;
  }) {
    const records = yield* ModelRecords;
    const sql = yield* SqlClient.SqlClient;
    const revisions = new Map<string, { readonly revisionSha256: string }>();
    for (const [name, doc] of input.documents) {
      const current = canvasFromDocument(name, doc);
      if (yield* records.getCanvas(name)) yield* records.removeCanvas(name);
      yield* records.createCanvas(name, `test-${name}`);
      for (const node of current.nodes.values()) yield* records.insertNode(name, node);
      for (const wire of current.wires.values()) yield* records.insertWire(name, wire);
      yield* sql`UPDATE canvases SET seq=${Number(input.generation)} WHERE canvas_name=${name}`;
      revisions.set(name, { revisionSha256: canvasBodySha256Of(serializeCanvas(doc)) });
    }
    return { intentSha256: intentSha256Of(revisions) };
  },
  Effect.provide(ModelRecords.layer),
);

export const canvasAuthorityMaterialFixture = (
  generation: string,
  input: ReadonlyMap<string, CanvasDoc>,
): CanvasAuthorityMaterialSnapshot => {
  const documents = new Map(input);
  const storedDocuments = new Map<string, CanvasAuthorityStoredDocument>();
  const revisions = new Map<string, { readonly revisionSha256: string }>();
  for (const [name, document] of documents) {
    const rawBody = serializeCanvas(document);
    const revisionSha256 = canvasBodySha256Of(rawBody);
    storedDocuments.set(name, { document, rawBody, revisionSha256 });
    revisions.set(name, { revisionSha256 });
  }
  return {
    generation,
    intentSha256: intentSha256Of(revisions),
    documents,
    storedDocuments,
  };
};
