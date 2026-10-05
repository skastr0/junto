import { PREVIEW_MAX_IMAGE_BYTES, PREVIEW_MAX_SVG_BYTES, previewExtension, previewKindOf } from "./preview";

/**
 * What a file is, judged by its bytes. One judge for every door a file comes
 * through: the preview read in main, an attachment arriving on a signal, and
 * the CLI's early refusal. No node APIs: bytes are a Uint8Array.
 */

const startsWith = (bytes: Uint8Array, signature: ReadonlyArray<number>, offset = 0): boolean =>
  bytes.length >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte);

/** Raster type by signature; the extension is never trusted. */
export const sniffRasterType = (bytes: Uint8Array): string | undefined => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  return undefined;
};

const SVG_ROOT = /^﻿?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE\s+svg[^>[]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/iu;

const SVG_ACTIVE = [
  /<\s*(?:script|foreignObject|iframe|embed|object|audio|video|animate[a-z]*|set|handler|listener)\b/iu,
  /\son[a-z]+\s*=/iu,
  /(?:javascript|vbscript)\s*:/iu,
  /<!ENTITY/iu,
  /@import/iu,
];
// A reference may point inside the file (#id) or carry an inline raster.
const SVG_REFERENCE = /(?:href|src)\s*=\s*(["'])\s*(?!#|data:image\/(?:png|jpeg|gif|webp)[;,])[^"']/iu;
const SVG_CSS_URL = /url\(\s*(["']?)\s*(?!#|data:image\/(?:png|jpeg|gif|webp)[;,])[^)\s]/iu;

/** An SVG that is only a drawing: nothing that runs, nothing that loads. */
export const isInertSvg = (source: string): boolean =>
  SVG_ROOT.test(source) &&
  !SVG_ACTIVE.some((pattern) => pattern.test(source)) &&
  !SVG_REFERENCE.test(source) &&
  !SVG_CSS_URL.test(source);

const hasNul = (bytes: Uint8Array): boolean => bytes.includes(0);

const decodeUtf8 = (bytes: Uint8Array): string => new TextDecoder("utf-8").decode(bytes);

/** An inert SVG's bytes are an image; anything else in SVG clothing is not. */
export const isInertSvgBytes = (bytes: Uint8Array): boolean =>
  bytes.byteLength <= PREVIEW_MAX_SVG_BYTES && !hasNul(bytes) && isInertSvg(decodeUtf8(bytes));

const TEXT_MEDIA_TYPES: Readonly<Record<string, string>> = {
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  diff: "text/x-diff",
  patch: "text/x-diff",
  txt: "text/plain",
  log: "text/plain",
};

export type AttachmentKind =
  | { readonly ok: true; readonly kind: "image" | "text"; readonly mediaType: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Whether a file may ride on a signal: only what a preview can show. An
 * image by its bytes (PNG, JPEG, GIF, WebP, or an SVG that is only a
 * drawing), or text by its name (txt, md, markdown, json, diff, patch, log)
 * with no NUL byte in it.
 */
export const classifyAttachment = (name: string, bytes: Uint8Array): AttachmentKind => {
  if (bytes.byteLength === 0) return { ok: false, reason: "the file is empty" };
  const raster = sniffRasterType(bytes);
  if (raster !== undefined) {
    return bytes.byteLength > PREVIEW_MAX_IMAGE_BYTES
      ? { ok: false, reason: "the image is too large" }
      : { ok: true, kind: "image", mediaType: raster };
  }
  const extension = previewExtension(`/${name}`);
  if (extension === "svg") {
    return isInertSvgBytes(bytes)
      ? { ok: true, kind: "image", mediaType: "image/svg+xml" }
      : { ok: false, reason: "the SVG carries script, an event handler or an outside reference, or is too large" };
  }
  if (previewKindOf(`/${name}`) === "image") {
    return { ok: false, reason: `the bytes are not a ${extension} image` };
  }
  const text = TEXT_MEDIA_TYPES[extension];
  if (text !== undefined) {
    return hasNul(bytes)
      ? { ok: false, reason: "the file is not text" }
      : { ok: true, kind: "text", mediaType: text };
  }
  return {
    ok: false,
    reason: "only images (png, jpg, jpeg, gif, webp, svg) and text (txt, md, markdown, json, diff, patch, log) can be attached",
  };
};
