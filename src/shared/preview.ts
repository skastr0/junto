/**
 * Previews of the local files an agent names in its own text (a signal's
 * detail today). Two halves share this module:
 *
 * - detection, pure: which local paths a piece of markdown names, in the
 *   order written, each with the words the agent put beside it;
 * - the read contract: what the renderer may ask main for, and what comes
 *   back. Main runs the same detection on the stored text and serves only
 *   the paths it finds there, so the renderer cannot ask for an arbitrary
 *   file (see `src/main/junto/preview/read.ts`).
 */

export type PreviewKind = "image" | "text" | "file";

/** One local file named in a piece of agent text. */
export type PreviewRef = {
  /** The path exactly as written: the key main checks a read against. */
  readonly path: string;
  /** Last path segment. */
  readonly name: string;
  /** Read off the extension; main decides from the bytes. */
  readonly kind: PreviewKind;
  /** The agent's own words beside the path ("Before"). Never made up. */
  readonly caption?: string;
};

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "json", "diff", "patch", "log"]);

/** Lower-case extension of a path's last segment, without the dot. */
export const previewExtension = (path: string): string => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

export const previewKindOf = (path: string): PreviewKind => {
  const extension = previewExtension(path);
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (TEXT_EXTENSIONS.has(extension)) return "text";
  return "file";
};

export const previewName = (path: string): string => {
  const trimmed = path.replace(/\/+$/u, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
};

/**
 * A local path: absolute, home-relative or a file URL, with a file extension
 * on its last segment. The extension keeps prose ("and/or", "/usr/bin") out.
 */
const LOCAL_PATH = /^(?:file:\/\/|~)?\/(?:[^/\u0000-\u001f]+\/)*[^/\u0000-\u001f]*\.[A-Za-z0-9]{1,8}$/u;

export const isLocalPreviewPath = (value: string): boolean => LOCAL_PATH.test(value);

// One pass, in the order written. Alternatives, most specific first:
// 1. a markdown image or link target: ![alt](target) / [label](target)
// 2. a code span whose whole content is a path (may hold spaces)
// 3. a bare path: starts at a word boundary, runs to whitespace or a bracket
const PATH_TOKEN = new RegExp(
  [
    String.raw`(!?)\[([^\]\n]*)\]\(\s*<?((?:file:\/\/|~)?\/[^)\n>]+?)>?(?:\s+"[^"\n]*")?\s*\)`,
    String.raw`\x60((?:file:\/\/|~)?\/[^\x60\n]+)\x60`,
    String.raw`(?<![\w/.:~\-\x60\\])((?:file:\/\/|~)?\/[^\s\x60"'<>()\[\]]+)`,
  ].join("|"),
  "gu",
);

/** List markers, quote marks and emphasis around a caption are not its words. */
const cleanCaption = (raw: string): string | undefined => {
  const text = raw
    .replace(/^[\s>]*(?:[-*+]|\d+[.)])?\s*/u, "")
    .replace(/^(?:and|,|;)\s+/iu, "")
    .replace(/[*_\x60]/gu, "")
    .replace(/[\s:=,;(—–-]+$/u, "")
    .trim();
  return text.length > 0 ? text : undefined;
};

/**
 * The local files a piece of markdown names, in the order written. A path
 * named twice is listed once, where it first appears.
 */
export const previewRefsIn = (markdown: string): ReadonlyArray<PreviewRef> => {
  const refs: PreviewRef[] = [];
  const seen = new Set<string>();
  for (const line of markdown.split("\n")) {
    let captionFrom = 0;
    for (const match of line.matchAll(PATH_TOKEN)) {
      const [whole, , label, target, spanned, bare] = match;
      const index = match.index;
      let path = (target ?? spanned ?? bare ?? "").trim();
      // Sentence punctuation after a bare path is not part of it.
      if (bare !== undefined) path = path.replace(/[.,;:!?]+$/u, "");
      const before = line.slice(captionFrom, index);
      captionFrom = index + whole.length;
      if (!isLocalPreviewPath(path) || seen.has(path)) continue;
      seen.add(path);
      const caption = cleanCaption(label !== undefined && label.trim() ? label : before);
      const name = previewName(path);
      refs.push({
        path,
        name,
        kind: previewKindOf(path),
        // A caption that only repeats the file name says nothing new.
        ...(caption !== undefined && caption !== name && caption !== path ? { caption } : {}),
      });
    }
  }
  return refs;
};

/**
 * The pair an A B view opens on: the two an agent labels before and after,
 * else the first two images. Undefined with fewer than two images.
 */
export const previewComparePair = (
  refs: ReadonlyArray<PreviewRef>,
): readonly [PreviewRef, PreviewRef] | undefined => {
  const images = refs.filter((ref) => ref.kind === "image");
  const [first, second] = images;
  if (!first || !second) return undefined;
  const labelled = (word: RegExp): PreviewRef | undefined =>
    images.find((ref) => word.test(ref.caption ?? "")) ??
    images.find((ref) => word.test(ref.name));
  const before = labelled(/\bbefore\b/iu);
  const after = labelled(/\bafter\b/iu);
  return before && after && before !== after ? [before, after] : [first, second];
};

// --- the read contract -------------------------------------------------------

/** Whole-file cap for an image, in bytes. */
export const PREVIEW_MAX_IMAGE_BYTES = 25 * 1024 * 1024;
/** An SVG is text that a parser walks: a far smaller cap. */
export const PREVIEW_MAX_SVG_BYTES = 2 * 1024 * 1024;
/** How much of a text file a preview reads, in bytes. */
export const PREVIEW_MAX_TEXT_BYTES = 64 * 1024;
/** Longest edge of a thumbnail, in device pixels. */
export const PREVIEW_THUMB_EDGE = 480;

/** Where the text that names the path lives. Main reads it from its own store. */
export type PreviewSource = { readonly kind: "signal"; readonly signalId: string };

export type PreviewRequest = {
  readonly source: PreviewSource;
  /** A path exactly as `previewRefsIn` returned it for that source's text. */
  readonly path: string;
  /** `thumb`: an image scaled down in main. `full`: the image as it is. */
  readonly variant: "thumb" | "full";
};

export type PreviewTextFormat = "markdown" | "json" | "diff" | "text";

export type PreviewResult =
  | {
      readonly ok: true;
      readonly kind: "image";
      readonly name: string;
      readonly byteLength: number;
      readonly mediaType: string;
      /** The image itself: the renderer never gets a file path to load. */
      readonly dataUrl: string;
    }
  | {
      readonly ok: true;
      readonly kind: "text";
      readonly name: string;
      readonly byteLength: number;
      readonly format: PreviewTextFormat;
      readonly text: string;
      /** The file is longer than what was read. */
      readonly truncated: boolean;
    }
  | {
      /** A file that exists and is not previewed: its name, type and size only. */
      readonly ok: true;
      readonly kind: "file";
      readonly name: string;
      readonly byteLength: number;
      readonly extension: string;
    }
  | {
      readonly ok: false;
      /**
       * `not-named`: the source's text does not name this path.
       * `missing`: nothing readable at the path, or not a regular file.
       */
      readonly reason: "not-named" | "missing";
    };

export type PreviewRevealResult = { readonly ok: boolean };
