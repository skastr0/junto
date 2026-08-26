import { serializeCanvas, type CanvasDoc } from "../../src/shared/canvas";
import {
  canvasBodySha256Of,
  intentSha256Of,
} from "../../src/main/vellum/canvas-intent-identity";
import type {
  CanvasAuthorityMaterialSnapshot,
  CanvasAuthorityStoredDocument,
} from "../../src/main/vellum/canvases";

export const canvasAuthorityMaterialFixture = (
  generation: string,
  input: ReadonlyMap<string, CanvasDoc>,
): CanvasAuthorityMaterialSnapshot => {
  const documents = new Map(input);
  const storedDocuments = new Map<
    string,
    CanvasAuthorityStoredDocument
  >();
  const revisions = new Map<
    string,
    { readonly revisionSha256: string }
  >();
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
