import { open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { isInertSvg, sniffRasterType } from "@shared/preview-bytes";
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
