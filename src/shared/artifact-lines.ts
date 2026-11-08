/**
 * The first lines of an artifact's body, as words: what a preview card draws.
 * Pure and shared, so the phone's mention chips read a body exactly as the
 * desktop's embeds do.
 */
import type { ArtifactBody } from "./artifact";

const MARKDOWN_LEAD = /^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/u;
const FENCE = /^\s{0,3}(?:```|~~~)/u;

/** A line of markdown as words: block markers and inline emphasis off. */
const plainLine = (line: string): string =>
  line
    .replace(MARKDOWN_LEAD, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/[*_`~]+/gu, "")
    .trim();

/** The first `count` lines a body says, as words, blank lines skipped. */
export const artifactFirstLines = (body: ArtifactBody, count = 2): ReadonlyArray<string> => {
  switch (body.type) {
    case "document": {
      const lines: string[] = [];
      let fenced = false;
      for (const raw of body.markdown.split("\n")) {
        if (FENCE.test(raw)) {
          fenced = !fenced;
          continue;
        }
        const line = fenced ? raw.trim() : plainLine(raw);
        if (line === "" || /^[-*_=\s|:]+$/u.test(line)) continue;
        lines.push(line);
        if (lines.length === count) break;
      }
      return lines;
    }
    case "sheet": {
      const { columns, rows } = body.grid;
      const head = columns.map((column) => column.name).filter((name) => name !== "").join(", ");
      const cells = rows.slice(0, Math.max(0, count - 1)).map((row) => columns.map((column) => row.cells[column.id] ?? "").filter((cell) => cell !== "").join(", "));
      return [head, ...cells].filter((line) => line !== "").slice(0, count);
    }
    case "pad": {
      const { shapes, inks, images } = body.pad;
      const parts = [
        shapes.length > 0 ? `${shapes.length} ${shapes.length === 1 ? "shape" : "shapes"}` : "",
        inks.length > 0 ? `${inks.length} ${inks.length === 1 ? "stroke" : "strokes"}` : "",
        images.length > 0 ? `${images.length} ${images.length === 1 ? "image" : "images"}` : "",
      ].filter((part) => part !== "");
      return parts.length > 0 ? [parts.join(", ")] : [];
    }
    case "link":
      return body.target.kind === "url" ? [body.target.url] : [body.target.content.displayName ?? body.target.content.mediaType];
    case "file":
      return [body.content.displayName ?? body.content.sha256.slice(0, 12), body.content.mediaType].slice(0, count);
  }
};

