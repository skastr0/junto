import { Effect } from "effect";
import type { ArtifactPublishCliArgs } from "../../shared/work-control";
import type { ContentPart } from "../../shared/work-model";
import { InputError } from "./errors";

/**
 * CLI boundary for artifact parts.
 *
 * Binary bytes are no longer read and Base64-encoded into the work socket.
 * The content service/CLI ingest surface must produce a ContentRef first;
 * this adapter only passes ref-only parts through to artifact.publish.
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
        return yield* Effect.fail(
          new InputError({
            message:
              "inline binary artifact parts are retired; ingest the file through the content service and pass a ContentRef part",
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
