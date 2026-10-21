/**
 * Junto pad IR, the body of a pad artifact. applyPatch is the only mutation.
 */
import { Result, Schema } from "effect";
import { ContentRef } from "./content";

const STRICT = { onExcessProperty: "error" } as const;

const FiniteNumber = Schema.Number.pipe(
  Schema.check(Schema.makeFilter(Number.isFinite, {
    message: "must be a finite number",
  })),
);

const PositiveSize = FiniteNumber.pipe(
  Schema.check(Schema.isGreaterThan(0)),
);

const Int = Schema.Number.pipe(Schema.check(Schema.isInt()));

const NonEmptyString = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
);

export const PadElementId = NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(256)),
  Schema.brand("PadElementId"),
);
export type PadElementId = typeof PadElementId.Type;

export const asPadElementId = (id: string): PadElementId => id as PadElementId;

export const PadShapeType = Schema.Literals(["box", "ellipse", "triangle", "label"]);
export type PadShapeType = typeof PadShapeType.Type;

export const PadShapeStatus = Schema.Literals(["none", "active", "done", "blocked"]);
export type PadShapeStatus = typeof PadShapeStatus.Type;

export const PadSide = Schema.Literals(["top", "right", "bottom", "left"]);
export type PadSide = typeof PadSide.Type;

export const PadLayer = Schema.Literals(["image", "shape", "edge", "ink"]);
export type PadLayer = typeof PadLayer.Type;

export const PadPoint = Schema.Struct({
  x: FiniteNumber,
  y: FiniteNumber,
});
export type PadPoint = typeof PadPoint.Type;

export const PadShape = Schema.Struct({
  id: PadElementId,
  type: PadShapeType,
  x: FiniteNumber,
  y: FiniteNumber,
  w: PositiveSize,
  h: PositiveSize,
  z: Int,
  fill: Schema.optionalKey(NonEmptyString),
  stroke: Schema.optionalKey(NonEmptyString),
  text: Schema.optionalKey(NonEmptyString),
  status: Schema.optionalKey(PadShapeStatus),
});
export type PadShape = typeof PadShape.Type;

export const PadEdge = Schema.Struct({
  id: PadElementId,
  from: PadElementId,
  to: PadElementId,
  fromSide: Schema.optionalKey(PadSide),
  toSide: Schema.optionalKey(PadSide),
  label: Schema.optionalKey(NonEmptyString),
});
export type PadEdge = typeof PadEdge.Type;

export const PadImage = Schema.Struct({
  id: PadElementId,
  x: FiniteNumber,
  y: FiniteNumber,
  w: PositiveSize,
  h: PositiveSize,
  z: Int,
  ref: ContentRef,
});
export type PadImage = typeof PadImage.Type;

export const PadInk = Schema.Struct({
  id: PadElementId,
  z: Int,
  color: NonEmptyString,
  width: PositiveSize,
  points: Schema.Array(PadPoint).pipe(Schema.check(Schema.isMinLength(2))),
});
export type PadInk = typeof PadInk.Type;

const collectElementIds = (pad: {
  readonly images: ReadonlyArray<{ readonly id: string }>;
  readonly shapes: ReadonlyArray<{ readonly id: string }>;
  readonly edges: ReadonlyArray<{ readonly id: string }>;
  readonly inks: ReadonlyArray<{ readonly id: string }>;
}): string[] => [
  ...pad.images.map((image) => image.id),
  ...pad.shapes.map((shape) => shape.id),
  ...pad.edges.map((edge) => edge.id),
  ...pad.inks.map((ink) => ink.id),
];

const padInvariants = (pad: {
  readonly images: ReadonlyArray<{ readonly id: string }>;
  readonly shapes: ReadonlyArray<{ readonly id: string }>;
  readonly edges: ReadonlyArray<{
    readonly id: string;
    readonly from: string;
    readonly to: string;
  }>;
  readonly inks: ReadonlyArray<{ readonly id: string }>;
}): true | string => {
  const ids = collectElementIds(pad);
  if (new Set(ids).size !== ids.length) {
    return "ids must be unique within the pad";
  }
  const shapeIds = new Set(pad.shapes.map((shape) => shape.id));
  for (const edge of pad.edges) {
    if (!shapeIds.has(edge.from) || !shapeIds.has(edge.to)) {
      return "edge endpoints must exist";
    }
  }
  return true;
};

/** Ids unique across the layers, and every edge's ends present. */
export const PadInvariants = Schema.makeFilter(padInvariants);

export const PadFields = {
  revision: Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  images: Schema.Array(PadImage),
  shapes: Schema.Array(PadShape),
  edges: Schema.Array(PadEdge),
  inks: Schema.Array(PadInk),
};

export const Pad = Schema.Struct(PadFields).pipe(Schema.check(PadInvariants));
export type Pad = typeof Pad.Type;

export const PadUpsertShape = Schema.Struct({
  op: Schema.Literal("upsert"),
  layer: Schema.Literal("shape"),
  shape: PadShape,
});
export type PadUpsertShape = typeof PadUpsertShape.Type;

export const PadUpsertEdge = Schema.Struct({
  op: Schema.Literal("upsert"),
  layer: Schema.Literal("edge"),
  edge: PadEdge,
});
export type PadUpsertEdge = typeof PadUpsertEdge.Type;

export const PadUpsertImage = Schema.Struct({
  op: Schema.Literal("upsert"),
  layer: Schema.Literal("image"),
  image: PadImage,
});
export type PadUpsertImage = typeof PadUpsertImage.Type;

export const PadUpsertInk = Schema.Struct({
  op: Schema.Literal("upsert"),
  layer: Schema.Literal("ink"),
  ink: PadInk,
});
export type PadUpsertInk = typeof PadUpsertInk.Type;

export const PadDelete = Schema.Struct({
  op: Schema.Literal("delete"),
  id: PadElementId,
});
export type PadDelete = typeof PadDelete.Type;

export const PadZ = Schema.Struct({
  op: Schema.Literal("z"),
  id: PadElementId,
  z: Int,
});
export type PadZ = typeof PadZ.Type;

export const PadPatch = Schema.Union([PadUpsertShape,
PadUpsertEdge,
PadUpsertImage,
PadUpsertInk,
PadDelete,
PadZ,]);
export type PadPatch = typeof PadPatch.Type;

export const PadErrorCode = Schema.Literals(["invalid", "duplicate_id",
"zero_size",
"dangling_edge",
"empty_ink",
"layer_mismatch",
"missing",]);
export type PadErrorCode = typeof PadErrorCode.Type;

export class PadError extends Schema.TaggedError<PadError>()("PadError", {
  code: PadErrorCode,
  message: Schema.String,
  id: Schema.optionalKey(PadElementId),
}) {}

export const decodePad = Schema.decodeUnknownResult(Pad, STRICT);
export const decodePadPatch = Schema.decodeUnknownResult(PadPatch, STRICT);
export const decodePadShape = Schema.decodeUnknownResult(PadShape, STRICT);
export const decodePadEdge = Schema.decodeUnknownResult(PadEdge, STRICT);
export const decodePadImage = Schema.decodeUnknownResult(PadImage, STRICT);
export const decodePadInk = Schema.decodeUnknownResult(PadInk, STRICT);

export const emptyPad = (): Pad => ({
  revision: 0,
  images: [],
  shapes: [],
  edges: [],
  inks: [],
});

const formatError = (error: unknown): string =>
  error instanceof Error && error.message.length > 0
    ? error.message
    : String(error);

const padFail = (
  code: PadErrorCode,
  message: string,
  id?: PadElementId,
): Result.Result<Pad, PadError> =>
  Result.fail(PadError.make(id === undefined ? { code, message } : { code, message, id }));

const schemaCode = (message: string): PadErrorCode => {
  if (/greater than 0/i.test(message)) return "zero_size";
  if (/min length 2|isMinLength\(2\)|at least 2/i.test(message)) return "empty_ink";
  if (/unique within the pad/i.test(message)) return "duplicate_id";
  if (/edge endpoints/i.test(message)) return "dangling_edge";
  return "invalid";
};

const layerOf = (pad: Pad, id: string): PadLayer | undefined => {
  if (pad.images.some((image) => image.id === id)) return "image";
  if (pad.shapes.some((shape) => shape.id === id)) return "shape";
  if (pad.edges.some((edge) => edge.id === id)) return "edge";
  if (pad.inks.some((ink) => ink.id === id)) return "ink";
  return undefined;
};

const replaceById = <T extends { readonly id: string }>(
  items: ReadonlyArray<T>,
  item: T,
): T[] => {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) return [...items, item];
  const next = items.slice();
  next[index] = item;
  return next;
};

const requireLayer = (
  pad: Pad,
  id: PadElementId,
  layer: PadLayer,
): Result.Result<void, PadError> => {
  const existing = layerOf(pad, id);
  if (existing !== undefined && existing !== layer) {
    return Result.fail(
      PadError.make({
        code: "layer_mismatch",
        message: `layer type cannot change (${existing} → ${layer})`,
        id,
      }),
    );
  }
  return Result.succeed(undefined);
};

const applyDecoded = (pad: Pad, patch: PadPatch): Result.Result<Pad, PadError> => {
  switch (patch.op) {
    case "upsert": {
      switch (patch.layer) {
        case "shape": {
          const allowed = requireLayer(pad, patch.shape.id, "shape");
          if (Result.isFailure(allowed)) return Result.fail(allowed.failure);
          return Result.succeed({
            ...pad,
            shapes: replaceById(pad.shapes, patch.shape),
          });
        }
        case "edge": {
          const allowed = requireLayer(pad, patch.edge.id, "edge");
          if (Result.isFailure(allowed)) return Result.fail(allowed.failure);
          const shapeIds = new Set(pad.shapes.map((shape) => shape.id));
          if (!shapeIds.has(patch.edge.from) || !shapeIds.has(patch.edge.to)) {
            return padFail(
              "dangling_edge",
              "edge endpoints must exist",
              patch.edge.id,
            );
          }
          return Result.succeed({
            ...pad,
            edges: replaceById(pad.edges, patch.edge),
          });
        }
        case "image": {
          const allowed = requireLayer(pad, patch.image.id, "image");
          if (Result.isFailure(allowed)) return Result.fail(allowed.failure);
          return Result.succeed({
            ...pad,
            images: replaceById(pad.images, patch.image),
          });
        }
        case "ink": {
          const allowed = requireLayer(pad, patch.ink.id, "ink");
          if (Result.isFailure(allowed)) return Result.fail(allowed.failure);
          return Result.succeed({
            ...pad,
            inks: replaceById(pad.inks, patch.ink),
          });
        }
      }
      break;
    }
    case "delete": {
      const layer = layerOf(pad, patch.id);
      if (layer === undefined) {
        return padFail("missing", "id does not exist", patch.id);
      }
      if (layer === "shape") {
        return Result.succeed({
          ...pad,
          shapes: pad.shapes.filter((shape) => shape.id !== patch.id),
          edges: pad.edges.filter(
            (edge) => edge.from !== patch.id && edge.to !== patch.id,
          ),
        });
      }
      return Result.succeed({
        ...pad,
        images: layer === "image"
          ? pad.images.filter((image) => image.id !== patch.id)
          : pad.images,
        edges: layer === "edge"
          ? pad.edges.filter((edge) => edge.id !== patch.id)
          : pad.edges,
        inks: layer === "ink"
          ? pad.inks.filter((ink) => ink.id !== patch.id)
          : pad.inks,
      });
    }
    case "z": {
      const layer = layerOf(pad, patch.id);
      if (layer === undefined) {
        return padFail("missing", "id does not exist", patch.id);
      }
      if (layer === "shape") {
        return Result.succeed({
          ...pad,
          shapes: pad.shapes.map((shape) =>
            shape.id === patch.id ? { ...shape, z: patch.z } : shape),
        });
      }
      if (layer === "image") {
        return Result.succeed({
          ...pad,
          images: pad.images.map((image) =>
            image.id === patch.id ? { ...image, z: patch.z } : image),
        });
      }
      if (layer === "ink") {
        return Result.succeed({
          ...pad,
          inks: pad.inks.map((ink) =>
            ink.id === patch.id ? { ...ink, z: patch.z } : ink),
        });
      }
      return padFail("invalid", "layer has no z", patch.id);
    }
  }
  return padFail("invalid", "unknown patch");
};

export const applyPatch = (
  pad: Pad,
  patch: PadPatch,
): Result.Result<Pad, PadError> => {
  const decodedPad = decodePad(pad);
  if (Result.isFailure(decodedPad)) {
    return padFail(
      schemaCode(formatError(decodedPad.failure)),
      `pad invalid: ${formatError(decodedPad.failure)}`,
    );
  }
  const decodedPatch = decodePadPatch(patch);
  if (Result.isFailure(decodedPatch)) {
    const message = formatError(decodedPatch.failure);
    return padFail(schemaCode(message), `patch invalid: ${message}`);
  }
  const applied = applyDecoded(decodedPad.success, decodedPatch.success);
  if (Result.isFailure(applied)) return applied;
  const next: Pad = {
    ...applied.success,
    revision: decodedPad.success.revision + 1,
  };
  const checked = decodePad(next);
  if (Result.isFailure(checked)) {
    return padFail(
      schemaCode(formatError(checked.failure)),
      `pad after patch invalid: ${formatError(checked.failure)}`,
    );
  }
  return Result.succeed(checked.success);
};

export const applyPatches = (
  pad: Pad,
  patches: ReadonlyArray<PadPatch>,
): Result.Result<Pad, PadError> => {
  let current = pad;
  for (const patch of patches) {
    const next = applyPatch(current, patch);
    if (Result.isFailure(next)) return next;
    current = next.success;
  }
  return Result.succeed(current);
};
