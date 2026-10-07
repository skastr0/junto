import { serializeCanvas, type CanvasDoc } from "../fixtures/frozen-canvas-types";
import { bodySha256Of as canvasBodySha256Of } from "../../src/main/junto/work/body-sha256";
import { intentSha256Of } from "./authorial-material";
import type {
  CanvasIntentMaterial,
  StoredCanvasIntentDocument as CanvasAuthorityStoredDocument,
} from "./authorial-material";
type CanvasAuthorityMaterialSnapshot = CanvasIntentMaterial & { readonly generation: string };

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
