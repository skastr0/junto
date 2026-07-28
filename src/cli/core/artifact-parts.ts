import { readFile } from "node:fs/promises";
import { Effect } from "effect";
import type { ArtifactPublishCliArgs } from "../../shared/work-control";
import { InputError } from "./errors";

/** CLI boundary: read path-based raw parts into bytesBase64. Never sent as path on the wire. */
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
      | { kind: "raw"; bytesBase64: string; mediaType?: string }
    >;
  },
  InputError
> =>
  Effect.gen(function* () {
    const parts = yield* Effect.forEach(input.parts, (part, index) =>
      Effect.gen(function* () {
        if (part.kind === "text" || part.kind === "url" || part.kind === "data") {
          return part;
        }
        // raw
        if (part.bytesBase64 && part.bytesBase64.length > 0) {
          return {
            kind: "raw" as const,
            bytesBase64: part.bytesBase64,
            ...(part.mediaType !== undefined ? { mediaType: part.mediaType } : {}),
          };
        }
        if (!part.path) {
          return yield* Effect.fail(
            new InputError({
              message: "raw part requires path or bytesBase64",
              path: `parts[${index}]`,
            }),
          );
        }
        const bytes = yield* Effect.tryPromise({
          try: () => readFile(part.path!),
          catch: (cause) =>
            new InputError({
              message: cause instanceof Error ? cause.message : "failed to read artifact path",
              path: part.path,
            }),
        });
        return {
          kind: "raw" as const,
          bytesBase64: bytes.toString("base64"),
          ...(part.mediaType !== undefined ? { mediaType: part.mediaType } : {}),
        };
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
