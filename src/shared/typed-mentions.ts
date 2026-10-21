/**
 * `@name` as a writer types it (docs/plans/0.10/03 section 1, "Writing from
 * the CLI"): main finds each name in a text, resolves it, and rewrites it to
 * its mention link, so the text it stores names the seat by link and never
 * by a name that can change. Pure: who a name may resolve to is the caller's.
 *
 * A name is left alone where it is not prose: inside a code span or a fenced
 * code block, inside a link already written (a markdown link, an autolink, a
 * bare URL), in an email or a handle on a host (`ops@junto.dev`,
 * `@user@host`), and after a backslash (`\@name`).
 */
import { Result } from "effect";
import { mentionLink, type MentionRef } from "./mention";

/** One `@name` in a text, by code-unit offsets: `text.slice(start, end)` is `@` and the name. */
export type TypedMention = { readonly name: string; readonly start: number; readonly end: number };

type Span = readonly [start: number, end: number];

const FENCE = /^ {0,3}(`{3,}|~{3,})/u;

/** Fenced code blocks, open fence to closing fence, or to the end of the text when unclosed. */
const fencedBlocks = (text: string): ReadonlyArray<Span> => {
  const spans: Span[] = [];
  let open: { readonly fence: string; readonly start: number } | undefined;
  let at = 0;
  for (const line of text.split("\n")) {
    const fence = FENCE.exec(line)?.[1];
    if (open === undefined) {
      if (fence !== undefined) open = { fence, start: at };
    } else if (fence !== undefined && fence[0] === open.fence[0] && fence.length >= open.fence.length && line.trim() === fence) {
      spans.push([open.start, at + line.length]);
      open = undefined;
    }
    at += line.length + 1;
  }
  if (open !== undefined) spans.push([open.start, text.length]);
  return spans;
};

/** Inline code spans: a backtick run closed by the next run of the same length. An unclosed run is text. */
const codeSpans = (text: string): ReadonlyArray<Span> => {
  const runs = [...text.matchAll(/`+/gu)].map((run) => ({ start: run.index, length: run[0].length }));
  const spans: Span[] = [];
  for (let i = 0; i < runs.length; i += 1) {
    const open = runs[i]!;
    const close = runs.findIndex((run, j) => j > i && run.length === open.length);
    if (close < 0) continue;
    spans.push([open.start, runs[close]!.start + open.length]);
    i = close;
  }
  return spans;
};

/** A markdown link or image, an autolink, or a bare URL with a scheme. */
const LINKED = /!?\[(?:\\.|[^\\\]\n])*\]\([^()\n]*\)|<[^<>\s]+>|\b[a-z][a-z0-9+.-]*:\/\/\S+/giu;

const linkedSpans = (text: string): ReadonlyArray<Span> =>
  [...text.matchAll(LINKED)].map((match): Span => [match.index, match.index + match[0].length]);

/**
 * `@` that starts a word, then a name of letters, digits and `_`, with `.`
 * and `-` inside it. Not after a letter, a digit or an email's characters,
 * and not followed by another `@`.
 */
const NAME = /(?<![\p{L}\p{N}_.%+\-@/\\])@([\p{L}\p{N}_](?:[\p{L}\p{N}_.-]*[\p{L}\p{N}_])?)(?![\p{L}\p{N}_@-])/gu;

/** Every `@name` in a text that is prose, in text order. */
export const typedMentionsOf = (text: string): ReadonlyArray<TypedMention> => {
  const fences = fencedBlocks(text);
  const outside = (spans: ReadonlyArray<Span>) => (at: number): boolean => !spans.some(([start, end]) => at >= start && at < end);
  const notFenced = outside(fences);
  const kept = [...fences, ...codeSpans(text).filter(([start]) => notFenced(start)), ...linkedSpans(text)];
  const prose = outside(kept);
  return [...text.matchAll(NAME)]
    .filter((match) => prose(match.index))
    .map((match) => ({ name: match[1]!, start: match.index, end: match.index + match[0].length }));
};

/** What a name resolves to: the mention and the label its link shows. */
export type ResolvedName = { readonly ref: MentionRef; readonly label: string };

/**
 * The text with each `@name` rewritten to its mention link on `canvasName`.
 * Each name is resolved once; the first name that does not resolve, in text
 * order, refuses the whole text with its refusal.
 */
export const linkTypedMentions = <E>(
  text: string,
  canvasName: string,
  resolve: (name: string) => Result.Result<ResolvedName, E>,
): Result.Result<string, E> => {
  const links = new Map<string, string>();
  let out = "";
  let at = 0;
  for (const { name, start, end } of typedMentionsOf(text)) {
    let link = links.get(name);
    if (link === undefined) {
      const resolved = resolve(name);
      if (Result.isFailure(resolved)) return Result.fail(resolved.failure);
      link = mentionLink(resolved.success.ref, resolved.success.label, canvasName);
      links.set(name, link);
    }
    out += text.slice(at, start) + link;
    at = end;
  }
  return Result.succeed(out + text.slice(at));
};
