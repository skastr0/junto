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

/** A line of text as a link keeps it: trimmed, on one line, cut at the bound. */
const lineOf = (text: string): string => {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= ARTIFACT_LINK_LINE_MAX ? flat : `${flat.slice(0, ARTIFACT_LINK_LINE_MAX - 1)}…`;
};

/** The line of `text` that holds `at`. */
const lineHolding = (text: string, at: number): string => {
  const before = text.lastIndexOf("\n", Math.max(0, at - 1));
  const after = text.indexOf("\n", at);
  return lineOf(text.slice(before + 1, after < 0 ? text.length : after));
};

/** A link target as an artifact link, or undefined when it names no item (a seat, a page). */
const artifactTargetOf = (target: MentionTarget): ArtifactLinkRef | undefined =>
  target.item === undefined ? undefined : { nodeId: target.nodeId, artifactId: target.item };

/** Every link in a text, with the line it is on. */
const linksInText = (text: string): ReadonlyArray<BodyLinkAt> =>
  mentionLinksOf(text).flatMap((link) => {
    const target = artifactTargetOf(link.target);
    return target === undefined ? [] : [{ target, line: lineHolding(text, link.start) }];
  });

/** Every link in a pad: a shape's text, and a card's own href. */
const linksInPad = (body: Extract<ArtifactBody, { readonly type: "pad" }>): ReadonlyArray<BodyLinkAt> => {
  const found: BodyLinkAt[] = [];
  const shapes = [...body.pad.shapes].sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const shape of shapes) {
    if (shape.text !== undefined) found.push(...linksInText(shape.text));
    if (shape.href !== undefined) {
      const parsed = mentionLinksOf(`[${shape.label ?? "a card"}](${shape.href})`);
      for (const link of parsed) {
        const target = artifactTargetOf(link.target);
        if (target !== undefined) found.push({ target, line: lineOf(shape.text ?? shape.label ?? "") });
      }
    }
  }
  return found;
};

/** Every link in a sheet: each cell's text, columns then rows, as the grid reads. */
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
