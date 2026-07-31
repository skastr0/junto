import { Effect } from "effect";
import type { ArtifactPublishCliArgs } from "../../shared/work-control";
import type { ContentPart, RawPart } from "../../shared/work-model";
import { InputError } from "./errors";

/**
 * CLI boundary for artifact parts.
 *
 * ContentRefs pass through directly. A legacy bytesBase64 input is admitted
 * only as an ingress form; WorkService externalizes it through ContentService
 * before any task/artifact fact or parts_json value is written. File paths are
 * not portable ingress and must be ingested through the content surface first.
 */
export const materializeArtifactParts = (
  input: ArtifactPublishCliArgs,
): Effect.Effect<
  {
    readonly target: string;
    readonly name?: string;
    readonly artifactId?: string;
    readonly task?: {
      readonly target: string;
      readonly id: string;
    };
    readonly metadata?: Record<string, unknown>;
    readonly parts: ReadonlyArray<
      | { kind: "text"; text: string }
      | { kind: "url"; url: string; mediaType?: string }
      | { kind: "data"; data: unknown }
      | RawPart
      | ContentPart
    >;
  },
  InputError
> =>
  Effect.gen(function* () {
    const parts = yield* Effect.forEach(input.parts, (part, index) =>
      Effect.gen(function* () {
        if (
          part.kind === "text" ||
          part.kind === "url" ||
          part.kind === "data" ||
          part.kind === "content"
        ) {
          return part;
        }
        if (part.bytesBase64 !== undefined) {
          return {
            kind: "raw" as const,
            bytesBase64: part.bytesBase64,
            ...(part.mediaType === undefined ? {} : { mediaType: part.mediaType }),
          };
        }
        return yield* Effect.fail(
          new InputError({
            message:
              "artifact file paths require content ingest; pass bytesBase64 only for the local ContentService adapter or pass a ContentRef part",
            path: `parts[${index}]`,
            hint: "use {kind: \"content\", ref: {sha256, byteLength, mediaType}}",
          }),
        );
      }),
    );

    return {
      target: input.target,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.artifactId !== undefined ? { artifactId: input.artifactId } : {}),
      ...(input.task !== undefined ? { task: input.task } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      parts,
    };
  });
