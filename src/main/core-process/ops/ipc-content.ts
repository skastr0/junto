/**
 * What the window writes and stages through the content core (junto/ipc.ts):
 * the operator's attachment pieces, an image put, the portrait overrides, and
 * a page box comment's shot purge. Every answer is plain data; the window
 * broadcasts what it must (a portrait save, a guidance write) after the call.
 */
import { Effect, Schema } from "effect";
import { OperatorContentPut, type OperatorContentPutResult } from "@shared/operator-attachments";
import type { PageShotPurged } from "@shared/page-shot";
import { isPortraitSeatId, normalizePortraitOverride, type PortraitOverrideSetResult } from "@shared/portrait-overrides";
import type { ContentRef } from "@shared/wire/content-ref";
import type { PortraitOverrides } from "@shared/portrait-overrides";
import { putOperatorContent } from "../../junto/content/operator-attachments";
import { ContentService } from "../../junto/content/service";
import { PortraitOverrideRepository } from "../../junto/portraits/repository";
import { purgeOperatorPageShot } from "../../junto/work/page-shot-purge";
import { coreOps, type CoreOp } from "../ops";

declare module "../ops" {
  interface CoreOps {
    "ipc.content.operatorPut": CoreOp<{ readonly input: unknown }, OperatorContentPutResult>;
    "ipc.content.putImage": CoreOp<
      { readonly input: unknown },
      { readonly ok: true; readonly ref: ContentRef } | { readonly ok: false; readonly error: string }
    >;
    "ipc.content.portraitOverrides": CoreOp<Record<string, never>, PortraitOverrides>;
    "ipc.content.portraitOverrideSet": CoreOp<
      { readonly seatId: unknown; readonly override: unknown },
      PortraitOverrideSetResult
    >;
    "ipc.content.pageShotPurge": CoreOp<
      { readonly canvasName: string; readonly nodeId: string; readonly messageId: string },
      PageShotPurged
    >;
  }
}

const IMAGE_PUT_MAX_BYTES = 16 * 1024 * 1024;
const IMAGE_PUT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/bmp",
]);

coreOps({
  // A file the operator attaches to mail, one piece at a time, staged as the
  // operator on the canvas the mail is written to.
  "ipc.content.operatorPut": ({ input }) =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(OperatorContentPut, { onExcessProperty: "error" })(input).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      );
      if (decoded === undefined) return { ok: false as const, message: "That piece of the file could not be read." };
      return yield* putOperatorContent(decoded.canvasName, decoded.stage);
    }),
  // Image content put: canvas image nodes and note embeds. The content store
  // only; the document carries ContentRef URLs, never Base64.
  "ipc.content.putImage": ({ input }) =>
    Effect.gen(function* () {
      const named = input as {
        readonly bytesBase64?: unknown;
        readonly mediaType?: unknown;
        readonly displayName?: unknown;
      };
      if (
        named === null ||
        typeof named !== "object" ||
        typeof named.bytesBase64 !== "string" ||
        typeof named.mediaType !== "string"
      ) {
        return { ok: false as const, error: "invalid image put input" };
      }
      const mediaType = named.mediaType.trim().toLowerCase().split(";")[0]?.trim() ?? "";
      if (!IMAGE_PUT_TYPES.has(mediaType)) {
        return { ok: false as const, error: `unsupported image media type: ${named.mediaType}` };
      }
      const normalized = named.bytesBase64.replace(/\s+/g, "");
      if (normalized.length === 0 || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized)) {
        return { ok: false as const, error: "invalid Base64 image payload" };
      }
      const bytes = Buffer.from(normalized, "base64");
      const withoutPadding = normalized.replace(/=+$/u, "");
      if (bytes.toString("base64").replace(/=+$/u, "") !== withoutPadding) {
        return { ok: false as const, error: "non-canonical Base64 image payload" };
      }
      if (bytes.length === 0) return { ok: false as const, error: "empty image" };
      if (bytes.length > IMAGE_PUT_MAX_BYTES) {
        return {
          ok: false as const,
          error: `image too large (${bytes.length} bytes; max ${IMAGE_PUT_MAX_BYTES})`,
        };
      }
      const displayName =
        typeof named.displayName === "string" && named.displayName.trim().length > 0
          ? named.displayName.trim().slice(0, 255)
          : undefined;
      const content = yield* ContentService;
      const result = yield* content
        .put({
          source: bytes,
          mediaType,
          ...(displayName !== undefined ? { displayName } : {}),
        })
        .pipe(Effect.mapError((error) => (error instanceof Error ? error : new Error(String(error)))));
      return { ok: true as const, ref: result.ref };
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed({ ok: false as const, error: error instanceof Error ? error.message : String(error) }),
      ),
    ),
  // The operator's per-seat character customization: an install-local
  // preference like settings (no canvas authoring).
  "ipc.content.portraitOverrides": () =>
    Effect.flatMap(PortraitOverrideRepository, (repository) => repository.list()),
  "ipc.content.portraitOverrideSet": ({ seatId, override }) =>
    Effect.gen(function* () {
      if (!isPortraitSeatId(seatId)) return { ok: false as const, message: "portrait seat id is invalid" };
      const stored = yield* Effect.flatMap(PortraitOverrideRepository, (repository) =>
        repository.set(seatId, override === null ? null : normalizePortraitOverride(override)),
      );
      return { ok: true as const, seatId, override: stored };
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed({ ok: false as const, message: error instanceof Error ? error.message : "portrait save failed" }),
      ),
    ),
  // The operator's purge of a page box comment's shot; the window holds the
  // main-authoring gate around this call.
  "ipc.content.pageShotPurge": ({ canvasName, nodeId, messageId }) =>
    purgeOperatorPageShot({ canvasName, nodeId, messageId }).pipe(
      Effect.catch(() => Effect.succeed({ ok: false as const, message: "The screenshot could not be removed." })),
    ),
});
