import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { Effect, Result, Schema } from "effect";
import type { ContentRef } from "../../shared/content";
import {
  CONTENT_STAGE_PIECE_BYTES,
  ContentStageResult,
  type ContentStageArgs,
} from "../../shared/content-stage";
import type { WorkOpName } from "../../shared/work-control";
import { AuthError, InputError, RuntimeDown, WireError } from "./errors";
import { WorkSocket } from "./socket";

/**
 * Put one file of this seat's into the content store and answer the
 * reference to name it by.
 *
 * The file is read from disk a piece at a time and each piece is its own
 * `content.stage` call, so a file of any size crosses the work socket
 * without ever being whole in memory, here or in main. The path stays on
 * this side: only bytes cross.
 *
 * The digest is taken as the pieces are read and sent with the last one,
 * so main refuses a file that did not arrive as it left.
 */
const CONTENT_STAGE_OP: WorkOpName = "content.stage";

export type StageFileInput = {
  readonly mediaType: string;
  readonly displayName?: string;
  readonly timeoutMs?: number;
};

const unreadable = (path: string) =>
  new InputError({
    message: "the file could not be read",
    path,
    hint: "check that the path names a file this process may read",
  });

const decodeResult = Schema.decodeUnknownResult(ContentStageResult);

export const stageFile = (
  path: string,
  input: StageFileInput,
): Effect.Effect<
  ContentRef,
  InputError | RuntimeDown | AuthError | WireError,
  WorkSocket
> =>
  Effect.gen(function* () {
    const socket = yield* WorkSocket;
    const call = (args: ContentStageArgs) =>
      socket.call(CONTENT_STAGE_OP, args, input.timeoutMs).pipe(
        Effect.flatMap((data) => {
          const decoded = decodeResult(data);
          return Result.isSuccess(decoded)
            ? Effect.succeed(decoded.success)
            : Effect.fail(
                new WireError({
                  type: "ProtocolError",
                  message: "content.stage answered in a form this CLI does not know",
                }),
              );
        }),
      );

    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({ try: () => open(path, "r"), catch: () => unreadable(path) }),
      (file) =>
        Effect.gen(function* () {
          const readPiece = Effect.tryPromise({
            try: async () => {
              const piece = Buffer.allocUnsafe(CONTENT_STAGE_PIECE_BYTES);
              let filled = 0;
              // A read may come back short before the end of the file.
              while (filled < piece.length) {
                const { bytesRead } = await file.read(piece, filled, piece.length - filled, null);
                if (bytesRead === 0) break;
                filled += bytesRead;
              }
              return piece.subarray(0, filled);
            },
            catch: () => unreadable(path),
          });

          const digest = createHash("sha256");
          let byteLength = 0;
          let stageId: string | undefined;
          // One piece is held back so the last one closes the upload itself.
          let held = yield* readPiece;
          for (;;) {
            digest.update(held);
            byteLength += held.length;
            const next = held.length < CONTENT_STAGE_PIECE_BYTES
              ? Buffer.alloc(0)
              : yield* readPiece;
            const last = next.length === 0;
            const answer = yield* call({
              ...(stageId === undefined ? {} : { stageId }),
              bytesBase64: held.toString("base64"),
              ...(last
                ? {
                    done: {
                      mediaType: input.mediaType,
                      ...(input.displayName === undefined
                        ? {}
                        : { displayName: input.displayName }),
                      expected: { sha256: digest.copy().digest("hex"), byteLength },
                    },
                  }
                : {}),
            } as ContentStageArgs);
            if ("ref" in answer) return answer.ref;
            if (last) {
              return yield* Effect.fail(
                new WireError({
                  type: "ProtocolError",
                  message: "content.stage did not close the upload",
                }),
              );
            }
            stageId = answer.stageId;
            held = next;
          }
        }),
      (file) => Effect.promise(() => file.close().catch(() => undefined)),
    );
  });
