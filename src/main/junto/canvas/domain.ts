import { Schema } from "effect";
import type { CanvasDoc } from "@shared/canvas";
import { CANVAS_NAME_INPUT_PATTERN, CANVAS_NAME_MAX_LENGTH } from "@shared/canvas-name";
import type { ActorRef } from "@shared/work-protocol";

export class CanvasError extends Schema.TaggedError<CanvasError>()("CanvasError", {
  message: Schema.String,
}) {}

export const toCanvasError = (error: unknown): CanvasError =>
  error instanceof CanvasError ? error : new CanvasError({
    message: error instanceof Error ? error.message : String(error),
  });

declare const canvasNameBrand: unique symbol;
export type CanvasName = string & { readonly [canvasNameBrand]: "CanvasName" };

/** Canonicalize an ASCII basename, never a path. */
export const canvasNameFrom = (raw: string): CanvasName => {
  const trimmed = raw.trim();
  if (!CANVAS_NAME_INPUT_PATTERN.test(trimmed)) {
    throw new CanvasError({
      message: `invalid canvas name "${raw}": use at most ${CANVAS_NAME_MAX_LENGTH} ASCII letters, numbers, hyphens, and underscores`,
    });
  }
  return trimmed.toLowerCase() as CanvasName;
};

export const canvasLabel = (name: CanvasName) => `canvas "${name}"`;

export type StoredCanvas = {
  readonly doc: CanvasDoc;
  readonly body: string;
  readonly revisionSha256: string;
  readonly modifiedAt: string;
};

export type StoredAuthoritySnapshot = {
  readonly hasHead: boolean;
  readonly generation: string;
  readonly createdAt: string | undefined;
  readonly intentSha256: string | undefined;
  readonly documents: ReadonlyMap<string, StoredCanvas>;
};

export type ActivePortfolioSnapshot = StoredAuthoritySnapshot & {
  readonly actorRefs: ReadonlyArray<ActorRef>;
};
