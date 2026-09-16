/**
 * Canvas + note image authoring helpers.
 *
 * Durable form is always a ContentRef in the content store, projected into the
 * document as a `junto-content://` object URL (file node `file` field, or
 * markdown `![alt](url)` in free notes). No Base64 in CanvasDoc.
 */

import type { ContentRef } from "@shared/content";
import {
  contentMediaKind,
  contentObjectUrl,
  parseContentObjectUrl,
} from "@shared/content-url";
import {
  extractClipboardImage,
  fileToClipboardImage,
  type ClipboardImage,
} from "./clipboard-image";

const EXT_TO_MEDIA_TYPE: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

export const mediaTypeFromImageExtension = (extension: string): string =>
  EXT_TO_MEDIA_TYPE[extension.toLowerCase()] ?? `image/${extension.toLowerCase()}`;

/** True when a file-node path is a content-store image URL. */
export const imageContentRefFromFile = (
  file: string,
): ContentRef | undefined => {
  const ref = parseContentObjectUrl(file);
  if (!ref) return undefined;
  if (contentMediaKind(ref.mediaType) !== "image") return undefined;
  return ref;
};

export const markdownImageLine = (
  ref: ContentRef,
  alt = "image",
): string => `![${alt.replace(/[\[\]]/g, "")}](${contentObjectUrl(ref)})`;

export type PutImageResult =
  | { readonly ok: true; readonly ref: ContentRef }
  | { readonly ok: false; readonly error: string };

/** Put a clipboard/file image into the content store via main. */
export const putClipboardImage = async (
  image: ClipboardImage,
  displayName?: string,
): Promise<PutImageResult> => {
  const api = window.vellumCommand;
  if (!api?.contentPutImage) {
    return { ok: false, error: "content put is unavailable" };
  }
  const mediaType = mediaTypeFromImageExtension(image.extension);
  try {
    return await api.contentPutImage({
      bytesBase64: image.dataBase64,
      mediaType,
      ...(displayName ? { displayName } : { displayName: `image.${image.extension}` }),
    });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

/**
 * Extract images from paste/drop and put each into the content store.
 * Returns refs in drop order; empty when no image present (not an error).
 */
export const putImagesFromDataTransfer = async (
  data: DataTransfer | null | undefined,
): Promise<
  | { readonly kind: "none" }
  | { readonly kind: "error"; readonly error: string }
  | { readonly kind: "ok"; readonly refs: ReadonlyArray<ContentRef> }
> => {
  if (!data) return { kind: "none" };

  // Multi-file drop: walk FileList; single clipboard paste still works via extract.
  const files = data.files?.length ? Array.from(data.files) : [];
  const imageFiles = files.filter(
    (file) =>
      file.type.startsWith("image/") ||
      /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name),
  );

  if (imageFiles.length > 0) {
    const refs: ContentRef[] = [];
    for (const file of imageFiles) {
      const image = await fileToClipboardImage(file);
      if ("error" in image) {
        return { kind: "error", error: image.error };
      }
      const put = await putClipboardImage(
        image,
        file.name.trim() || `image.${image.extension}`,
      );
      if (!put.ok) return { kind: "error", error: put.error };
      refs.push(put.ref);
    }
    return { kind: "ok", refs };
  }

  const single = await extractClipboardImage(data);
  if (single === null) return { kind: "none" };
  if ("error" in single) return { kind: "error", error: single.error };
  const put = await putClipboardImage(single);
  if (!put.ok) return { kind: "error", error: put.error };
  return { kind: "ok", refs: [put.ref] };
};
