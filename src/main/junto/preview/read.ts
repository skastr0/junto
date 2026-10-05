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

type PreviewRender = {
  readonly variant: "thumb" | "full";
  readonly thumbnail?: PreviewThumbnailer;
  readonly thumbEdge: number;
};

/**
 * Preview one located file. `judgedAs` is the name whose extension says
 * whether it is text; `tryImage` says whether its bytes are looked at as an
 * image at all.
 */
const previewLocated = async (
  file: { readonly path: string; readonly byteLength: number; readonly name: string },
  judgedAs: string,
  tryImage: boolean,
  render: PreviewRender,
): Promise<PreviewResult> => {
  const { path, byteLength, name } = file;
  const plain: PreviewResult = { ok: true, kind: "file", name, byteLength, extension: previewExtension(judgedAs) };
  try {
    if (previewKindOf(judgedAs) === "text") {
      const head = await readHead(path, PREVIEW_MAX_TEXT_BYTES);
      if (head.includes(0)) return plain;
      return {
        ok: true,
        kind: "text",
        name,
        byteLength,
        format: TEXT_FORMATS[previewExtension(judgedAs)] ?? "text",
        text: head.toString("utf8"),
        truncated: byteLength > head.length,
      };
    }
    if (!tryImage || byteLength > PREVIEW_MAX_IMAGE_BYTES) return plain;

    const signature = await readHead(path, 16);
    const raster = sniffRasterType(signature);
    if (raster !== undefined) {
      const bytes = await readHead(path, byteLength);
      if (render.variant === "thumb") {
        const thumb = render.thumbnail?.(bytes, render.thumbEdge);
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
    return plain;
  } catch {
    return MISSING;
  }
};

/**
 * Read one preview of a path. `text` is the stored text that must name
 * `written` (undefined when the source does not exist).
 */
export const readPreview = async (
  input: { readonly text: string | undefined; readonly path: string } & PreviewRender,
): Promise<PreviewResult> => {
  const located = await locate(input.text, input.path);
  if ("ok" in located) return located;
  // Judged by the resolved file, so a link named a.txt cannot dress up
  // another kind of file.
  const tryImage = previewKindOf(located.path) === "image" || previewKindOf(input.path) === "image";
  return previewLocated({ ...located, name: previewName(input.path) }, located.path, tryImage, input);
};

/**
 * Read one preview of a file a signal carries as an attachment. The caller
 * resolved it from the signal's own attachment list to its object in the
 * content store: there is no path from the agent here at all. The same
 * limits and the same judging by bytes apply as for a path.
 */
export const readAttachmentPreview = async (
  input: {
    /** The content store's own file for the attachment. */
    readonly objectPath: string;
    readonly byteLength: number;
    /** The attachment's display name: what it is called and how text is told. */
    readonly name: string;
  } & PreviewRender,
): Promise<PreviewResult> =>
  previewLocated(
    { path: input.objectPath, byteLength: input.byteLength, name: input.name },
    `/${input.name}`,
    true,
    input,
  );

/** The real path to show in the file manager, under the same guard as a read. */
export const locatePreviewForReveal = async (
  text: string | undefined,
  written: string,
): Promise<string | undefined> => {
  const located = await locate(text, written);
  return "ok" in located ? undefined : located.path;
};
