/**
 * Mentions as a writer types them (docs/plans/0.10/03 section 1, "Writing
 * from the CLI"): `@name` for a seat or a page, `#42` for a task by its
 * per-canvas number, `#name` for a task or an artifact by its title. Main
 * finds each token in a text, resolves it, and rewrites it to its mention
 * link, so the text it stores names the thing by link and never by a name
 * that can change. Pure: what a token may resolve to is the caller's.
 *
 * A token is left alone where it is not prose: inside a code span or a fenced
 * code block, inside a link already written (a markdown link, an autolink, a
 * bare URL), in an email or a handle on a host (`ops@junto.dev`,
 * `@user@host`), in an HTML entity (`&#42;`), after a letter or a digit
 * (`C#`, `a#b`), and after a backslash (`\@name`, `\#42`).
 */
import { Result } from "effect";
import { mentionLink, type MentionRef } from "./mention";

/**
 * One token in a text, by code-unit offsets: `text.slice(start, end)` is the
 * token as typed. A closed union: a resolver handles every kind or does not
 * typecheck (`matchTypedMention`).
 */
export type TypedMention =
  /** `@name`: a seat or a page, by name. */
  | { readonly kind: "at"; readonly name: string; readonly start: number; readonly end: number }
  /** `#42`: a task, by its per-canvas number (04). */
  | { readonly kind: "number"; readonly number: number; readonly start: number; readonly end: number }
  /** `#name`: a task or an artifact, by its title. */
  | { readonly kind: "hash"; readonly name: string; readonly start: number; readonly end: number };

export type TypedMentionKind = TypedMention["kind"];
type TypedMentionOf<K extends TypedMentionKind> = Extract<TypedMention, { readonly kind: K }>;

/** One case per kind, all required. */
export const matchTypedMention = <A>(
  token: TypedMention,
  cases: { readonly [K in TypedMentionKind]: (token: TypedMentionOf<K>) => A },
): A => (cases[token.kind] as (token: TypedMention) => A)(token);

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

/** `#` that starts a word, then digits alone. Not after a letter, a digit, `&` (an entity) or another `#`. */
const NUMBER = /(?<![\p{L}\p{N}_&#/\\])#(\d+)(?![\p{L}\p{N}_])/gu;

/** `#` that starts a word, then a name that starts with a letter, shaped as `@name`'s. */
const HASH = /(?<![\p{L}\p{N}_&#/\\])#(\p{L}(?:[\p{L}\p{N}_.-]*[\p{L}\p{N}_])?)(?![\p{L}\p{N}_@-])/gu;

/** Every token in a text that is prose, in text order. */
export const typedMentionsOf = (text: string): ReadonlyArray<TypedMention> => {
  const fences = fencedBlocks(text);
  const outside = (spans: ReadonlyArray<Span>) => (at: number): boolean => !spans.some(([start, end]) => at >= start && at < end);
  const notFenced = outside(fences);
  const kept = [...fences, ...codeSpans(text).filter(([start]) => notFenced(start)), ...linkedSpans(text)];
  const prose = outside(kept);
  const found = <M>(pattern: RegExp, token: (match: RegExpExecArray, start: number, end: number) => M): ReadonlyArray<M> =>
    [...text.matchAll(pattern)]
      .filter((match) => prose(match.index))
      .map((match) => token(match, match.index, match.index + match[0].length));
  return [
    ...found(NAME, (match, start, end): TypedMention => ({ kind: "at", name: match[1]!, start, end })),
    ...found(NUMBER, (match, start, end): TypedMention => ({ kind: "number", number: Number(match[1]), start, end })),
    ...found(HASH, (match, start, end): TypedMention => ({ kind: "hash", name: match[1]!, start, end })),
  ].sort((a, b) => a.start - b.start);
};

/** One key per thing a token asks for: the same token typed twice is resolved once. */
const tokenKey = (token: TypedMention): string =>
  matchTypedMention(token, {
    at: (at) => `@${at.name}`,
    number: (number) => `#${number.number}`,
    hash: (hash) => `#${hash.name}`,
  });

/** What a token resolves to: the mention and the label its link shows. */
export type ResolvedName = { readonly ref: MentionRef; readonly label: string };

/**
 * The text with every token rewritten to its mention link on `canvasName`.
 * Each token is resolved once. A token the resolver leaves (`undefined`)
 * stays as typed; the first refused, in text order, refuses the whole text.
 */
export const linkMentionTokens = <E>(
  text: string,
  canvasName: string,
  resolve: (token: TypedMention) => Result.Result<ResolvedName | undefined, E>,
): Result.Result<string, E> => {
  const links = new Map<string, string>();
  let out = "";
  let at = 0;
  for (const token of typedMentionsOf(text)) {
    const key = tokenKey(token);
    let link = links.get(key);
    if (link === undefined) {
      const resolved = resolve(token);
      if (Result.isFailure(resolved)) return Result.fail(resolved.failure);
      link = resolved.success === undefined
        ? text.slice(token.start, token.end)
        : mentionLink(resolved.success.ref, resolved.success.label, canvasName);
      links.set(key, link);
    }
    out += text.slice(at, token.start) + link;
    at = token.end;
  }
  return Result.succeed(out + text.slice(at));
};
