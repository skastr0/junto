import { Schema } from "effect";
import { CanvasDoc } from "./canvas";

export const AUTHORING_CODEC_FAMILY = "vellum-command-authoring" as const;
export const AUTHORING_CODEC_VERSION = 1 as const;
export const DOCUMENT_REPLACE_V1 = "document.replace/v1" as const;
export const AUTHORING_ORIGIN_COMMAND_CENTER = "command-center" as const;

const HexSha256 = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
);

const ChangeId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(256)),
);

/**
 * Current full-document renderer save, compiled until typed field commands exist.
 * Provenance fields are not in the schema; excess keys fail closed.
 */
export const DocumentReplaceV1 = Schema.Struct({
  kind: Schema.Literal(DOCUMENT_REPLACE_V1),
  changeId: ChangeId,
  canvasName: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(64)),
  ),
  doc: CanvasDoc,
  baseGeneration: Schema.optionalKey(Schema.String),
  baseBodyHash: Schema.optionalKey(HexSha256),
  objectHashes: Schema.optionalKey(Schema.Record(Schema.String, HexSha256)),
});
export type DocumentReplaceV1 = typeof DocumentReplaceV1.Type;

export const AuthoringCommand = Schema.Union([DocumentReplaceV1]);
export type AuthoringCommand = typeof AuthoringCommand.Type;

export const decodeAuthoringCommand = Schema.decodeUnknownResult(
  AuthoringCommand,
  { onExcessProperty: "error" },
);
