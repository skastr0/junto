/**
 * Links from one artifact to another (plan 0.11, 02): what a body holds, read
 * as links, so a reader can ask what points at an artifact.
 *
 * A link is a mention link, by id (`src/shared/mention.ts`): the form a `#`
 * picker writes and a `[[Title]]` is stored as, so a rename never breaks it.
 * This module is pure and knows no canvas: it returns the target a link names
 * (its node and item) and the text around it. Main decides which of those
 * targets are artifacts on the canvas it is projecting, and reads the titles
 * from there.
 */
import type { ArtifactBody, ArtifactType } from "./artifact";
import { mentionLinksOf, type MentionTarget } from "./mention";
import type { NodeId } from "./physics/schema";
import type { ItemId } from "./work-ids";

/** An artifact named by the node that shows it and the artifact's own id. */
export type ArtifactLinkRef = { readonly nodeId: NodeId; readonly artifactId: ItemId };

/** How long the text around a link is kept: a line a reader can read, not the whole body. */
export const ARTIFACT_LINK_LINE_MAX = 240;

/**
 * One artifact link in a body, with the text it sits in: the line of a
 * document or a pad shape, or a sheet cell's text. Cut to
 * ARTIFACT_LINK_LINE_MAX.
 */
export type BodyLinkAt = {
  readonly target: ArtifactLinkRef;
  readonly line: string;
};

/** An artifact whose body links the one asked about: what "Linked from" lists. */
export type LinkedFromBody = {
  /** The artifact holding the link. */
  readonly source: ArtifactLinkRef;
  /** Its title as it stands now. */
  readonly title: string;
  readonly type: ArtifactType;
  /** The line the link is on, as the body holds it now, cut to the line bound. */
  readonly line: string;
  /** Epoch ms of the version the link was read from. */
  readonly at: number;
};

/** A link's key, as a projection stores the pair: the two ids, never a title. */
export const artifactLinkKeyOf = (ref: ArtifactLinkRef): string => `${ref.nodeId}\u0000${ref.artifactId}`;

/** `text` cut at `max`, never through a character's surrogate pair. */
const cutAt = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
};

/** A line as a link keeps it: one line, trimmed, cut at the bound. */
const lineOf = (text: string): string => {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= ARTIFACT_LINK_LINE_MAX ? flat : `${cutAt(flat, ARTIFACT_LINK_LINE_MAX - 1)}…`;
};

/**
 * The text a link is read in: its line when the line fits, else a window of
 * the line around the link itself, never cut inside the link (a cut link is
 * no link to a reader that would parse it back). An ellipsis marks each side
 * the window left out.
 */
const lineHolding = (text: string, link: { readonly start: number; readonly end: number }): string => {
  const lineFrom = text.lastIndexOf("\n", Math.max(0, link.start - 1)) + 1;
  const lineTo = text.indexOf("\n", link.end);
  const line = text.slice(lineFrom, lineTo < 0 ? text.length : lineTo);
  const start = link.start - lineFrom;
  const stop = link.end - lineFrom;
  const flat = line.replace(/\s+/gu, " ").trim();
  if (flat.length <= ARTIFACT_LINK_LINE_MAX) return flat;
  const room = Math.max(0, ARTIFACT_LINK_LINE_MAX - (stop - start) - 2);
  const before = Math.min(start, Math.floor(room / 2));
  const after = Math.min(line.length - stop, room - before);
  const head = start - before > 0 ? "…" : "";
  const tail = stop + after < line.length ? "…" : "";
  return lineOf(`${head}${line.slice(start - before, stop + after)}${tail}`);
};

/** A link target as an artifact link, or undefined when it names no item (a seat, a page). */
const artifactTargetOf = (target: MentionTarget): ArtifactLinkRef | undefined =>
  target.item === undefined ? undefined : { nodeId: target.nodeId, artifactId: target.item };

/** Every link in a text, with the line it is on. */
const linksInText = (text: string): ReadonlyArray<BodyLinkAt> =>
  mentionLinksOf(text).flatMap((link) => {
    const target = artifactTargetOf(link.target);
    return target === undefined ? [] : [{ target, line: lineHolding(text, link) }];
  });

/** Every link in a pad: a shape's text, and a card's own href. */
const linksInPad = (body: Extract<ArtifactBody, { readonly type: "pad" }>): ReadonlyArray<BodyLinkAt> => {
  const found: BodyLinkAt[] = [];
  const shapes = [...body.pad.shapes].sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const shape of shapes) {
    if (shape.text !== undefined) found.push(...linksInText(shape.text));
    if (shape.href !== undefined) {
      // A fixed label: the href is the link, and a card's own label may hold a
      // bracket that would end the markdown link early.
      for (const link of mentionLinksOf(`[card](${shape.href})`)) {
        const target = artifactTargetOf(link.target);
        if (target !== undefined) found.push({ target, line: lineOf(shape.text ?? shape.label ?? "") });
      }
    }
  }
  return found;
};

/** Every link in a sheet: each cell's text, row by row, columns in their own order. */
const linksInSheet = (body: Extract<ArtifactBody, { readonly type: "sheet" }>): ReadonlyArray<BodyLinkAt> => {
  const found: BodyLinkAt[] = [];
  for (const row of body.grid.rows) {
    for (const column of body.grid.columns) {
      const text = row.cells[column.id];
      if (typeof text === "string") found.push(...linksInText(text));
    }
  }
  return found;
};

/**
 * The links an artifact's body holds, one per target, in the order the body
 * first names it: document markdown, pad text and card links, sheet cells. A
 * file and a link body hold no text, so they hold no links. A target named
 * twice keeps its first line: a projection has one row per (source, target).
 */
export const bodyLinksOf = (body: ArtifactBody): ReadonlyArray<BodyLinkAt> => {
  const found = (() => {
    switch (body.type) {
      case "document":
        return linksInText(body.markdown);
      case "pad":
        return linksInPad(body);
      case "sheet":
        return linksInSheet(body);
      case "file":
      case "link":
        return [];
    }
  })();
  const seen = new Set<string>();
  return found.filter((link) => {
    const key = artifactLinkKeyOf(link.target);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
