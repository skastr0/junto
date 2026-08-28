import { serializeCanvas, type CanvasDoc } from "../../src/shared/canvas";
import {
  canvasBodySha256Of,
  intentSha256Of,
} from "../../src/main/vellum/canvas-intent-identity";
import type {
  CanvasAuthorityMaterialSnapshot,
  CanvasAuthorityStoredDocument,
} from "../../src/main/vellum/canvases";
import {
  persistCanvas,
  writePortfolioHead,
  type CanvasSqlWriter,
} from "../../src/main/vellum/canvas/records";

/**
 * Seed the relational canvas authority directly: portfolio head plus one
 * relational record set per canvas. The one seeding path for tests that used
 * to INSERT blob generation rows.
 */
export const seedCanvasAuthority = (
  writer: CanvasSqlWriter,
  input: {
    readonly generation: string;
    readonly documents: ReadonlyMap<string, CanvasDoc>;
    readonly at?: string;
  },
): { readonly intentSha256: string } => {
  const at = input.at ?? new Date().toISOString();
  const revisions = new Map<string, { readonly revisionSha256: string }>();
  for (const [name, doc] of input.documents) {
    const revisionSha256 = canvasBodySha256Of(serializeCanvas(doc));
    persistCanvas(writer, {
      canvasName: name,
      doc,
      revisionSha256,
      modifiedAt: at,
    });
    revisions.set(name, { revisionSha256 });
  }
  const intentSha256 = intentSha256Of(revisions);
  writePortfolioHead(writer, {
    generation: input.generation,
    intentSha256,
    at,
  });
  return { intentSha256 };
};

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
