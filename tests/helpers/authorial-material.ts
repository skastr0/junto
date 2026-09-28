import type { CanvasDoc } from "../../src/shared/canvas";
import {
  canvasBodySha256Of,
  intentSha256Of,
} from "../../src/main/junto/canvas-intent-identity";
import type { CanvasAuthorityMaterialSnapshot } from "../../src/main/junto/canvases";

export const authorialMaterialForTest = (input: {
  readonly generation: string;
  readonly documents: ReadonlyMap<
    string,
    { readonly document: CanvasDoc; readonly rawBody: string }
  >;
}): CanvasAuthorityMaterialSnapshot => {
  const documents = new Map<string, CanvasDoc>();
  const storedDocuments = new Map<
    string,
    {
      readonly document: CanvasDoc;
      readonly rawBody: string;
      readonly revisionSha256: string;
    }
  >();
  for (const [name, entry] of input.documents) {
    const revisionSha256 = canvasBodySha256Of(entry.rawBody);
    documents.set(name, entry.document);
    storedDocuments.set(name, {
      document: entry.document,
      rawBody: entry.rawBody,
      revisionSha256,
    });
  }
  return {
    generation: input.generation,
    intentSha256: intentSha256Of(storedDocuments),
    documents,
    storedDocuments,
  };
};
