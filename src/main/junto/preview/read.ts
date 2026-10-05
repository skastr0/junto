import { open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PREVIEW_MAX_IMAGE_BYTES,
  PREVIEW_MAX_SVG_BYTES,
  PREVIEW_MAX_TEXT_BYTES,
  previewExtension,
  previewKindOf,
  previewName,
  previewRefsIn,
  type PreviewResult,
  type PreviewTextFormat,
} from "@shared/preview";

/**
 * The one read path for previews of files an agent names in its text.
 *
 * What it serves, and nothing else:
 * - a path the given text itself names (`previewRefsIn`): the caller hands
 *   main the stored text, never the renderer's copy, so a renderer cannot
 *   ask for a file no agent wrote down;
 * - a local path only: absolute, `~/` or `file://`. Never a URL, never a
 *   fetch. Symlinks are resolved first and the target is what gets judged;
 * - a regular file only;
 * - an image when its bytes say so (PNG, JPEG, GIF, WebP by signature; SVG by
 *   its root element), whatever the extension claims, up to
 *   PREVIEW_MAX_IMAGE_BYTES (SVG: PREVIEW_MAX_SVG_BYTES). An SVG that carries
 *   script, foreignObject, an event handler, or any reference outside itself
 *   is not served as an image;
 * - text when the resolved file's extension is txt, md, markdown, json, diff,
 *   patch or log and the bytes hold no NUL: the first PREVIEW_MAX_TEXT_BYTES;
 * - for any other file: its name, extension and size. No bytes.
 *
 * It never writes, never lists a directory, and returns no path the caller
 * did not already hold.
 */

export type PreviewThumbnailer = (
  bytes: Buffer,
  edge: number,
) => { readonly bytes: Buffer; readonly mediaType: string } | undefined;

const MISSING: PreviewResult = { ok: false, reason: "missing" };
const NOT_NAMED: PreviewResult = { ok: false, reason: "not-named" };

/** The path on disk a written path means, or undefined when it is not local. */
export const resolvePreviewPath = (written: string, home: string = homedir()): string | undefined => {
  if (written.includes("\u0000")) return undefined;
  let path = written;
  if (path.startsWith("file://")) {
    try {
      path = fileURLToPath(path);
    } catch {
      return undefined;
    }
  } else if (path.startsWith("~/")) {
    path = `${home}${path.slice(1)}`;
  }
  return isAbsolute(path) ? path : undefined;
};

const startsWith = (bytes: Buffer, signature: ReadonlyArray<number>, offset = 0): boolean =>
  bytes.length >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte);

/** Raster type by signature; the extension is never trusted. */
export const sniffRasterType = (bytes: Buffer): string | undefined => {
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

const TEXT_FORMATS: Readonly<Record<string, PreviewTextFormat>> = {
  md: "markdown",
  markdown: "markdown",
  json: "json",
  diff: "diff",
  patch: "diff",
  txt: "text",
  log: "text",
};

const dataUrl = (mediaType: string, bytes: Buffer): string =>
  `data:${mediaType};base64,${bytes.toString("base64")}`;

const readHead = async (path: string, limit: number): Promise<Buffer> => {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

/** The file on disk behind a path the text names, or why there is none. */
const locate = async (
  text: string | undefined,
  written: string,
): Promise<{ readonly path: string; readonly byteLength: number } | PreviewResult> => {
  if (text === undefined || !previewRefsIn(text).some((ref) => ref.path === written)) return NOT_NAMED;
  const local = resolvePreviewPath(written);
  if (local === undefined) return MISSING;
  try {
    const path = await realpath(local);
    const info = await stat(path);
    return info.isFile() ? { path, byteLength: info.size } : MISSING;
  } catch {
    return MISSING;
  }
};

/**
 * Read one preview. `text` is the stored text that must name `written`
 * (undefined when the source does not exist).
 */
export const readPreview = async (input: {
  readonly text: string | undefined;
  readonly path: string;
  readonly variant: "thumb" | "full";
  readonly thumbnail?: PreviewThumbnailer;
  readonly thumbEdge: number;
}): Promise<PreviewResult> => {
  const located = await locate(input.text, input.path);
  if ("ok" in located) return located;
  const { path, byteLength } = located;
  const name = previewName(input.path);
  const file: PreviewResult = { ok: true, kind: "file", name, byteLength, extension: previewExtension(path) };

  try {
    // Judged by the resolved file, so a link named a.txt cannot dress up
    // another kind of file.
    const kind = previewKindOf(path);
    if (kind === "text") {
      const head = await readHead(path, PREVIEW_MAX_TEXT_BYTES);
      if (head.includes(0)) return file;
      return {
        ok: true,
        kind: "text",
        name,
        byteLength,
        format: TEXT_FORMATS[previewExtension(path)] ?? "text",
        text: head.toString("utf8"),
        truncated: byteLength > head.length,
      };
    }
    if (kind !== "image" && previewKindOf(input.path) !== "image") return file;
    if (byteLength > PREVIEW_MAX_IMAGE_BYTES) return file;

    const signature = await readHead(path, 16);
    const raster = sniffRasterType(signature);
    if (raster !== undefined) {
      const bytes = await readHead(path, byteLength);
      if (input.variant === "thumb") {
        const thumb = input.thumbnail?.(bytes, input.thumbEdge);
        if (thumb) {
          return { ok: true, kind: "image", name, byteLength, mediaType: thumb.mediaType, dataUrl: dataUrl(thumb.mediaType, thumb.bytes) };
        }
      }
      return { ok: true, kind: "image", name, byteLength, mediaType: raster, dataUrl: dataUrl(raster, bytes) };
    }
    if (byteLength <= PREVIEW_MAX_SVG_BYTES) {
      const bytes = await readHead(path, byteLength);
      if (!bytes.includes(0) && isInertSvg(bytes.toString("utf8"))) {
        return { ok: true, kind: "image", name, byteLength, mediaType: "image/svg+xml", dataUrl: dataUrl("image/svg+xml", bytes) };
      }
    }
    return file;
  } catch {
    return MISSING;
  }
};

/** The real path to show in the file manager, under the same guard as a read. */
export const locatePreviewForReveal = async (
  text: string | undefined,
  written: string,
): Promise<string | undefined> => {
  const located = await locate(text, written);
  return "ok" in located ? undefined : located.path;
};
