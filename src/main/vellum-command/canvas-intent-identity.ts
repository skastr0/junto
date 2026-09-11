import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Result } from "effect";
import {
  containsWorkProjection,
  decodeCanvasDoc,
  type CanvasDoc,
} from "@shared/canvas";
import { isCanonicalCanvasName } from "@shared/canvas-name";

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

export class CanvasIntentIdentityError extends Error {
  override readonly name = "CanvasIntentIdentityError";
}

export const canvasBodySha256Of = (rawBody: string): string =>
  createHash("sha256").update(rawBody, "utf8").digest("hex");

/**
 * Exact durable authorial intent identity used by existing canvas generations.
 *
 * `localeCompare` is a historical part of this identity algorithm. It is not a
 * code-unit comparator, including for canonical names containing `-` or `_`.
 * Replacing it would change existing identity bytes and requires a separately
 * authorized identity migration. The byte-length framing and revision hashes
 * below are equally fixed.
 */
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

const identityError = (message: string): never => {
  throw new CanvasIntentIdentityError(message);
};

const decodeSemanticDocument = (
  name: string,
  value: unknown,
  source: string,
): CanvasDoc => {
  if (containsWorkProjection(value)) {
    return identityError(
      `canvas intent ${source} contains runtime work projection data: ${name}`,
    );
  }
  const decoded = decodeCanvasDoc(value);
  if (Result.isFailure(decoded)) {
    return identityError(
      `canvas intent ${source} failed strict semantic decode: ${name}: ${decoded.failure.message}`,
    );
  }
  return decoded.success;
};

const decodeRawDocument = (
  name: string,
  rawBody: string,
): CanvasDoc => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch (error) {
    return identityError(
      `canvas intent raw body is not valid JSON: ${name}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return decodeSemanticDocument(name, parsed, "raw body");
};

/**
 * Verify that raw authorial bytes, their scrubbed semantic documents, and the
 * portfolio intent hash are one coherent identity.
 *
 * This is authentication material validation only. It does not register or
 * mint repository authority. Callers must still obtain the material from the
 * app-owned StateEngine snapshot and bind it to the expected intent basis.
 */
export const verifyCanvasIntentMaterial = (
  material: CanvasIntentMaterial,
): void => {
  if (material.documents.size !== material.storedDocuments.size) {
    identityError("canvas intent document key count mismatch");
  }

  const revisions = new Map<string, CanvasIntentRevision>();
  for (const [name, document] of material.documents) {
    if (!isCanonicalCanvasName(name)) {
      identityError(
        `canvas intent contains a non-canonical document key: ${name}`,
      );
    }
    const stored = material.storedDocuments.get(name);
    if (stored === undefined) {
      throw new CanvasIntentIdentityError(
        `canvas intent stored-document key mismatch: ${name}`,
      );
    }
    const revisionSha256 = canvasBodySha256Of(stored.rawBody);
    if (revisionSha256 !== stored.revisionSha256) {
      identityError(`canvas intent raw body hash mismatch: ${name}`);
    }

    const rawDocument = decodeRawDocument(name, stored.rawBody);
    const storedDocument = decodeSemanticDocument(
      name,
      stored.document,
      "stored document",
    );
    const callerDocument = decodeSemanticDocument(name, document, "document");
    if (
      !isDeepStrictEqual(rawDocument, storedDocument) ||
      !isDeepStrictEqual(rawDocument, callerDocument)
    ) {
      identityError(`canvas intent semantic document mismatch: ${name}`);
    }
    revisions.set(name, { revisionSha256 });
  }

  for (const name of material.storedDocuments.keys()) {
    if (!isCanonicalCanvasName(name) || !material.documents.has(name)) {
      identityError(`canvas intent document key mismatch: ${name}`);
    }
  }

  if (intentSha256Of(revisions) !== material.intentSha256) {
    identityError("canvas intent portfolio hash mismatch");
  }
};
