import { Effect } from "effect";
import { serializeCanvas, type CanvasDoc } from "../../src/shared/canvas";
import {
  canvasBodySha256Of,
  intentSha256Of,
} from "../../src/main/junto/canvas-intent-identity";
import type {
  CanvasAuthorityMaterialSnapshot,
  CanvasAuthorityStoredDocument,
} from "../../src/main/junto/canvases";
import {
  CanvasRecords,
  CanvasRecordsLive,
} from "../../src/main/junto/canvas/records";

/**
 * Seed the relational canvas authority directly: portfolio head plus one
 * relational record set per canvas. The one seeding path for tests that used
 * to INSERT blob generation rows.
 */
export const seedCanvasAuthority = Effect.fn("test.seedCanvasAuthority")(
  function* (input: {
    readonly generation: string;
    readonly documents: ReadonlyMap<string, CanvasDoc>;
    readonly at?: string;
  }) {
    const records = yield* CanvasRecords;
    const at = input.at ?? new Date().toISOString();
    const revisions = new Map<string, { readonly revisionSha256: string }>();
    for (const [name, doc] of input.documents) {
      const revisionSha256 = canvasBodySha256Of(serializeCanvas(doc));
      yield* records.persistCanvas({
        canvasName: name,
        doc,
        revisionSha256,
        modifiedAt: at,
      });
      revisions.set(name, { revisionSha256 });
    }
    const intentSha256 = intentSha256Of(revisions);
    yield* records.writePortfolioHead({
      generation: input.generation,
      intentSha256,
      at,
    });
    return { intentSha256 };
  },
  Effect.provide(CanvasRecordsLive),
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
