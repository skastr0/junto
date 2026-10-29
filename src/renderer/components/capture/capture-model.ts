/**
 * Quick capture's pure parts (docs/plans/0.11/11-quick-capture.md, Q2): the
 * title a capture's first line gives it, and what its words become when its
 * type changes.
 *
 * An artifact's type is fixed for its life (the domain refuses a replace of
 * another type), so a capture changes type as a new artifact in the same
 * node, made from the old one's words, and the old one is archived; undo
 * archives the new one and restores the old. Nothing is ever lost to a
 * switch.
 */
import { ARTIFACT_MAX_DOCUMENT_LENGTH, ARTIFACT_MAX_TITLE_LENGTH, type ArtifactBody, emptyBody, padOf } from "@shared/artifact";
import { mentionLinksOf } from "@shared/mention";
import type { PadElementId, PadShape } from "@shared/pad";
import { SHEET_MAX_CELL_LENGTH, SHEET_MAX_COLUMNS, SHEET_MAX_ROWS } from "@shared/sheet";

/** The types a capture can be. */
export const CAPTURE_TYPES = ["document", "pad", "sheet"] as const;
export type CaptureType = (typeof CAPTURE_TYPES)[number];

export const isCaptureType = (type: string): type is CaptureType => (CAPTURE_TYPES as ReadonlyArray<string>).includes(type);

/** The title of a capture whose first line gives none. */
export const UNTITLED_CAPTURE = "Untitled capture";

/** `text` cut at `max`, never through a surrogate pair. */
const cut = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const last = head.charCodeAt(head.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
};

/** A line as read: mention links as their labels, `[[Title]]` as its title, no markdown marks around it. */
const plainLine = (line: string): string => {
  let out = "";
  let at = 0;
  for (const link of mentionLinksOf(line)) {
    out += line.slice(at, link.start) + link.label;
    at = link.end;
  }
  out += line.slice(at);
  return out
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/u, "")
    .replace(/\[\[([^\]\n]+)\]\]/gu, "$1")
    .replace(/(\*\*|__|\*|_|~~|`)(.+?)\1/gu, "$2")
    .replace(/\s+/gu, " ")
    .trim();
};

/**
 * The title a capture's first line gives it: the first line with words in
 * it, read plain and cut to the title bound; undefined when nothing written
 * has words.
 */
export const captureTitleOf = (markdown: string): string | undefined => {
  for (const line of markdown.split("\n")) {
    const plain = plainLine(line);
    if (plain !== "") return cut(plain, ARTIFACT_MAX_TITLE_LENGTH).trim();
  }
  return undefined;
};

/** Whether a body holds nothing written: a switch of an empty capture just changes its type. */
export const isEmptyCapture = (body: ArtifactBody): boolean => {
  switch (body.type) {
    case "document":
      return body.markdown.trim() === "";
    case "pad": {
      const pad = padOf(body);
      return pad.shapes.length === 0 && pad.edges.length === 0 && pad.inks.length === 0 && pad.images.length === 0;
    }
    case "sheet":
      return body.grid.rows.every((row) => Object.values(row.cells).every((cell) => cell.trim() === ""));
    case "link":
    case "file":
      return false;
  }
};

/** A body's words as lines: a document's lines, a pad's text boxes, a sheet's rows with their cells joined. */
const linesOf = (body: ArtifactBody): ReadonlyArray<string> => {
  switch (body.type) {
    case "document":
      return body.markdown.split("\n");
    case "pad":
      return [...padOf(body).shapes]
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .flatMap((shape) => (shape.text === undefined ? [] : shape.text.split("\n")));
    case "sheet": {
      const columns = body.grid.columns.map((column) => column.id);
      return body.grid.rows.map((row) =>
        columns
          .map((id) => row.cells[id] ?? "")
          .filter((cell) => cell.trim() !== "")
          .join("\t"),
      );
    }
    case "link":
    case "file":
      return [];
  }
};

/** Pad text box geometry: wide enough to read, a line's height per line. */
const BOX = { x: 40, y: 40, w: 520, line: 22, pad: 16 } as const;

/**
 * What a capture's words become as `to`. A document keeps its lines; a pad
 * keeps them as one text box; a sheet keeps one line per row, a sheet's
 * cells split back out of a tab. Blank lines are not rows. Past a type's
 * bounds the rest is cut, never refused.
 */
export const convertCapture = (body: ArtifactBody, to: CaptureType): ArtifactBody => {
  if (body.type === to) return body;
  if (isEmptyCapture(body)) return emptyBody(to);
  const lines = linesOf(body);
  switch (to) {
    case "document":
      return { type: "document", markdown: cut(lines.join("\n"), ARTIFACT_MAX_DOCUMENT_LENGTH) };
    case "pad": {
      const text = lines.join("\n").replace(/^\n+|\n+$/gu, "");
      const shape: PadShape = {
        id: "capture-text" as PadElementId,
        type: "label",
        x: BOX.x,
        y: BOX.y,
        w: BOX.w,
        h: BOX.pad + BOX.line * Math.max(1, text.split("\n").length),
        z: 0,
        text,
      };
      return { type: "pad", pad: { revision: 0, images: [], shapes: [shape], edges: [], inks: [] } };
    }
    case "sheet": {
      const rows = lines.filter((line) => line.trim() !== "").slice(0, SHEET_MAX_ROWS);
      const width = Math.max(1, ...rows.map((line) => line.split("\t").length));
      const columns = Array.from({ length: Math.min(width, SHEET_MAX_COLUMNS) }, (_, index) => ({
        id: `c${String(index + 1)}`,
        name: index < 26 ? `Column ${String.fromCharCode(65 + index)}` : `Column ${String(index + 1)}`,
      }));
      return {
        type: "sheet",
        grid: {
          columns,
          rows: rows.map((line, index) => {
            const cells: Record<string, string> = {};
            line.split("\t").forEach((cell, at) => {
              const column = columns[at];
              if (column !== undefined && cell.trim() !== "") cells[column.id] = cut(cell.trim(), SHEET_MAX_CELL_LENGTH);
            });
            return { id: `r${String(index + 1)}`, cells };
          }),
        },
      };
    }
  }
};

/** The type switch's word for a type. */
export const captureTypeName = (type: CaptureType): string => (type === "document" ? "Document" : type === "pad" ? "Pad" : "Sheet");
