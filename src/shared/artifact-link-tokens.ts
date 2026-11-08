/**
 * `[[Title]]` as a seat types it in an artifact's body (plan 0.11, 02, L5).
 * Main resolves each to one artifact in the seat's reach and rewrites it to
 * its link (`artifact-link.ts`) before the write is ruled, so a stored body
 * names the artifact by id, the same link the app's `[[` picker writes.
 *
 * Pure: what a title resolves to is the caller's. A token is read only in
 * prose, as typed mentions are (`proseOf`): not in code, not inside a link
 * already written (a stored `[[ ]]` link's label is escaped, so it is never
 * read again), and not after a backslash (`\[[`).
 *
 * The text a write carries, by body type: a document's markdown, a pad's
 * shape text, a sheet's cells. A document's patches keep the seat's splices
 * as sent and gain one splice per token they wrote, against the patched text.
 */
import { Result } from "effect";
import type { ArtifactBody, ArtifactEdit, TextPatch } from "./artifact";
import { ARTIFACT_MAX_PATCHES } from "./artifact";
import { proseOf } from "./typed-mentions";

/** One `[[Title]]` in a text, by code-unit offsets: `text.slice(start, end)` is the token as typed. */
export type ArtifactLinkToken = { readonly title: string; readonly start: number; readonly end: number };

const TOKEN = /(?<!\\)\[\[([^[\]\n]+)\]\]/gu;

/** Every `[[Title]]` in a text that is prose, in text order. A blank title is text. */
export const artifactLinkTokensOf = (text: string): ReadonlyArray<ArtifactLinkToken> => {
  const prose = proseOf(text);
  return [...text.matchAll(TOKEN)]
    .filter((match) => prose(match.index) && match[1]!.trim() !== "")
    .map((match) => ({ title: match[1]!, start: match.index, end: match.index + match[0].length }));
};

/** Resolve a title to its link text. Called once per title a write carries. */
export type ResolveTitle<E> = (title: string) => Result.Result<string, E>;

/** The same title typed twice is one lookup. */
const once = <E>(resolve: ResolveTitle<E>): ResolveTitle<E> => {
  const seen = new Map<string, Result.Result<string, E>>();
  return (title) => {
    const key = title.trim();
    const known = seen.get(key);
    if (known !== undefined) return known;
    const resolved = resolve(key);
    seen.set(key, resolved);
    return resolved;
  };
};

/** The text with each token in `only` (or every token) rewritten; the first refused, in text order, refuses it. */
const rewrite = <E>(
  text: string,
  resolve: ResolveTitle<E>,
  only: (token: ArtifactLinkToken) => boolean = () => true,
): Result.Result<string, E> => {
  let out = "";
  let at = 0;
  for (const token of artifactLinkTokensOf(text)) {
    if (!only(token)) continue;
    const link = resolve(token.title);
    if (Result.isFailure(link)) return link;
    out += text.slice(at, token.start) + link.success;
    at = token.end;
  }
  return Result.succeed(at === 0 ? text : out + text.slice(at));
};

/** Whether a write's text has a token at all: the caller reads artifacts in reach only then. */
export const hasArtifactLinkTokens = (texts: ReadonlyArray<string>): boolean =>
  texts.some((text) => artifactLinkTokensOf(text).length > 0);

/** The texts a body carries that may hold a token. */
export const bodyTexts = (body: ArtifactBody): ReadonlyArray<string> => {
  switch (body.type) {
    case "document":
      return [body.markdown];
    case "pad":
      return body.pad.shapes.flatMap((shape) => (shape.text === undefined ? [] : [shape.text]));
    case "sheet":
      return body.grid.rows.flatMap((row) => Object.values(row.cells));
    case "link":
    case "file":
      return [];
  }
};

/** A whole body with every token linked. */
export const linkBodyTitles = <E>(body: ArtifactBody, resolveTitle: ResolveTitle<E>): Result.Result<ArtifactBody, E> => {
  const resolve = once(resolveTitle);
  switch (body.type) {
    case "document":
      return Result.map(rewrite(body.markdown, resolve), (markdown) => ({ ...body, markdown }));
    case "pad": {
      const shapes: Array<(typeof body.pad.shapes)[number]> = [];
      for (const shape of body.pad.shapes) {
        if (shape.text === undefined) {
          shapes.push(shape);
          continue;
        }
        const text = rewrite(shape.text, resolve);
        if (Result.isFailure(text)) return Result.fail(text.failure);
        shapes.push({ ...shape, text: text.success });
      }
      return Result.succeed({ ...body, pad: { ...body.pad, shapes } });
    }
    case "sheet": {
      const rows: Array<(typeof body.grid.rows)[number]> = [];
      for (const row of body.grid.rows) {
        const cells: Record<string, string> = {};
        for (const [column, value] of Object.entries(row.cells)) {
          const text = rewrite(value, resolve);
          if (Result.isFailure(text)) return Result.fail(text.failure);
          cells[column] = text.success;
        }
        rows.push({ ...row, cells });
      }
      return Result.succeed({ ...body, grid: { ...body.grid, rows } });
    }
    case "link":
    case "file":
      return Result.succeed(body);
  }
};

/** The texts an edit writes that may hold a token. */
export const editTexts = (edit: ArtifactEdit): ReadonlyArray<string> => {
  if (edit.kind === "replace") return bodyTexts(edit.body);
  switch (edit.type) {
    case "document":
      return edit.patches.map((patch) => patch.insert);
    case "sheet":
      return edit.patches.flatMap((patch) => (patch.op === "cell" ? [patch.value] : []));
    case "pad":
      return edit.patches.flatMap((patch) =>
        patch.op === "upsert" && patch.layer === "shape" && patch.shape.text !== undefined ? [patch.shape.text] : []);
  }
};

type Range = readonly [start: number, end: number];

/**
 * The document after its splices, and the ranges in it the splices inserted.
 * Undefined when a splice runs past the end: the ruler refuses that edit itself.
 */
const spliced = (markdown: string, patches: ReadonlyArray<TextPatch>): { readonly text: string; readonly inserted: ReadonlyArray<Range> } | undefined => {
  let text = markdown;
  let inserted: Range[] = [];
  for (const patch of patches) {
    if (patch.at + patch.remove > text.length) return undefined;
    const cut = patch.at + patch.remove;
    const shift = patch.insert.length - patch.remove;
    inserted = inserted.flatMap(([start, end]): Range[] => {
      if (end <= patch.at) return [[start, end]];
      if (start >= cut) return [[start + shift, end + shift]];
      // Cut through by this splice: what is left of it on either side.
      return [
        ...(start < patch.at ? [[start, patch.at] as Range] : []),
        ...(end > cut ? [[patch.at + patch.insert.length, end + shift] as Range] : []),
      ];
    });
    if (patch.insert.length > 0) inserted.push([patch.at, patch.at + patch.insert.length]);
    text = text.slice(0, patch.at) + patch.insert + text.slice(cut);
  }
  return { text, inserted };
};

/** Why a document's patches could not take their links. */
export type PatchLinkRefusal = { readonly kind: "too-many-patches"; readonly max: number };

/**
 * An edit with every token it writes linked. A document's patches are read
 * against `head`, its markdown at the edit's base: a token any splice wrote
 * any part of is linked by one more splice, last to first, so the seat's
 * splices stay as sent. A token already in the document is left alone.
 */
export const linkEditTitles = <E>(
  edit: ArtifactEdit,
  head: ArtifactBody | null,
  resolveTitle: ResolveTitle<E>,
): Result.Result<ArtifactEdit, E | PatchLinkRefusal> => {
  const resolve = once(resolveTitle);
  if (edit.kind === "replace") return Result.map(linkBodyTitles(edit.body, resolve), (body) => ({ ...edit, body }));
  switch (edit.type) {
    case "document": {
      if (head?.type !== "document") return Result.succeed(edit);
      const after = spliced(head.markdown, edit.patches);
      if (after === undefined) return Result.succeed(edit);
      const written = (token: ArtifactLinkToken): boolean =>
        after.inserted.some(([start, end]) => token.start < end && start < token.end);
      const links: TextPatch[] = [];
      for (const token of artifactLinkTokensOf(after.text).filter(written).reverse()) {
        const link = resolve(token.title);
        if (Result.isFailure(link)) return Result.fail(link.failure);
        links.push({ op: "splice", at: token.start, remove: token.end - token.start, insert: link.success });
      }
      if (links.length === 0) return Result.succeed(edit);
      if (edit.patches.length + links.length > ARTIFACT_MAX_PATCHES) {
        return Result.fail({ kind: "too-many-patches", max: ARTIFACT_MAX_PATCHES });
      }
      return Result.succeed({ ...edit, patches: [...edit.patches, ...links] });
    }
    case "sheet": {
      const patches: Array<(typeof edit.patches)[number]> = [];
      for (const patch of edit.patches) {
        if (patch.op !== "cell") {
          patches.push(patch);
          continue;
        }
        const value = rewrite(patch.value, resolve);
        if (Result.isFailure(value)) return Result.fail(value.failure);
        patches.push({ ...patch, value: value.success });
      }
      return Result.succeed({ ...edit, patches });
    }
    case "pad": {
      const patches: Array<(typeof edit.patches)[number]> = [];
      for (const patch of edit.patches) {
        if (patch.op !== "upsert" || patch.layer !== "shape" || patch.shape.text === undefined) {
          patches.push(patch);
          continue;
        }
        const text = rewrite(patch.shape.text, resolve);
        if (Result.isFailure(text)) return Result.fail(text.failure);
        patches.push({ ...patch, shape: { ...patch.shape, text: text.success } });
      }
      return Result.succeed({ ...edit, patches });
    }
  }
};
