import { createHash } from "node:crypto";
import type { CanvasDoc } from "../fixtures/frozen-canvas-types";
import { bodySha256Of as canvasBodySha256Of } from "../../src/main/junto/work/body-sha256";

/** Historical portfolio identity used only by frozen station test fixtures. */
/** Raw and semantic forms of one document in an authorial generation. */
export type StoredCanvasIntentDocument = {
  readonly document: CanvasDoc;
  readonly rawBody: string;
  readonly revisionSha256: string;
};

/** Required material used to authenticate one authorial portfolio identity. */
export type CanvasIntentMaterial = {
  readonly intentSha256: string;
  readonly documents: ReadonlyMap<string, CanvasDoc>;
  readonly storedDocuments: ReadonlyMap<string, StoredCanvasIntentDocument>;
};

type CanvasIntentRevision = {
  readonly revisionSha256: string;
};

export const intentSha256Of = (
  documents: ReadonlyMap<string, CanvasIntentRevision>,
): string => {
  const hash = createHash("sha256");
  for (const [name, entry] of [...documents].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    hash.update(String(Buffer.byteLength(name, "utf8")));
    hash.update("\0");
    hash.update(name, "utf8");
    hash.update("\0");
    hash.update(entry.revisionSha256, "ascii");
    hash.update("\0");
  }
  return hash.digest("hex");
};

type CanvasAuthorityMaterialSnapshot = CanvasIntentMaterial & { readonly generation: string };

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
