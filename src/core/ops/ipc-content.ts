/**
 * The core's handlers of the content group (src/contract/core/content.ts):
 * what the window writes and stages through the content core. The operator's
 * attachment pieces, an image put, the portrait overrides, and a page box
 * comment's shot purge. Every answer is plain data; the window broadcasts
 * what it must (a portrait save, a guidance write) after the call.
 */
import { Effect } from "effect";
import { putOperatorContent } from "../content/operator-attachments";
import { ContentService } from "../content/service";
import { PortraitOverrideRepository } from "../portraits/repository";
import { purgeOperatorPageShot } from "../work/page-shot-purge";
import { ContentRpcs, PortraitOverridesUnavailable } from "../../contract/core/content";

const IMAGE_PUT_MAX_BYTES = 16 * 1024 * 1024;
const IMAGE_PUT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/bmp",
]);

export const ContentHandlers = ContentRpcs.toLayer({
  // A file the operator attaches to mail, one piece at a time, staged as the
  // operator on the canvas the mail is written to.
  ContentOperatorPut: ({ canvasName, stage }) => putOperatorContent(canvasName, stage),
  // Image content put: canvas image nodes and note embeds. The content store
  // only; the document carries ContentRef URLs, never Base64.
  ContentPutImage: (input) =>
    Effect.gen(function* () {
      const mediaType = input.mediaType.trim().toLowerCase().split(";")[0]?.trim() ?? "";
      if (!IMAGE_PUT_TYPES.has(mediaType)) {
        return { ok: false as const, error: `unsupported image media type: ${input.mediaType}` };
      }
      const normalized = input.bytesBase64.replace(/\s+/g, "");
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
        input.displayName !== undefined && input.displayName.trim().length > 0
          ? input.displayName.trim().slice(0, 255)
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
  ContentPortraitOverrides: () =>
    Effect.flatMap(PortraitOverrideRepository, (repository) => repository.list()).pipe(
      Effect.mapError((error) => new PortraitOverridesUnavailable({ message: error.message })),
    ),
  ContentPortraitOverrideSet: ({ seatId, override }) =>
    Effect.flatMap(PortraitOverrideRepository, (repository) => repository.set(seatId, override)).pipe(
      Effect.map((stored) => ({ ok: true as const, seatId, override: stored })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
    ),
  // The operator's purge of a page box comment's shot; the window holds the
  // main-authoring gate around this call.
  ContentPageShotPurge: (comment) => purgeOperatorPageShot(comment),
});
