/**
 * Dotenv syntax, as the files operators already have are written:
 *
 *   # comment
 *   NAME=value
 *   export NAME=value
 *   NAME="double quoted, with \n \t \" \\ escapes, may span lines"
 *   NAME='single quoted, taken literally, may span lines'
 *   NAME=bare value   # trailing comment
 *
 * A later assignment to a name overrides an earlier one. No `${VAR}`
 * expansion: the file says what it says. Lines that are not assignments are
 * counted, never guessed at.
 */

/** A name a process environment accepts. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export type DotenvParse = {
  readonly values: Record<string, string>;
  /** Lines that were neither blank, a comment, nor a valid assignment. */
  readonly skipped: number;
};

const DOUBLE_ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  r: "\r",
  t: "\t",
  '"': '"',
  "\\": "\\",
  $: "$",
};

export const parseDotenv = (text: string): DotenvParse => {
  const values: Record<string, string> = {};
  let skipped = 0;
  const source = text.replace(/^﻿/u, "").replace(/\r\n?/gu, "\n");
  let at = 0;
  const lineEnd = (from: number): number => {
    const end = source.indexOf("\n", from);
    return end < 0 ? source.length : end;
  };
  while (at < source.length) {
    const end = lineEnd(at);
    const line = source.slice(at, end);
    const head = /^\s*(?:export\s+)?([^\s=#]+)\s*=[ \t]*/u.exec(line);
    if (!head) {
      if (line.trim() !== "" && !line.trimStart().startsWith("#")) skipped += 1;
      at = end + 1;
      continue;
    }
    const name = head[1]!;
    const start = at + head[0].length;
    const quote = source[start];
    let value: string;
    if (quote === '"' || quote === "'") {
      // Quoted: runs to the matching quote, across lines.
      let cursor = start + 1;
      let out = "";
      let closed = false;
      while (cursor < source.length) {
        const ch = source[cursor]!;
        if (quote === '"' && ch === "\\" && cursor + 1 < source.length) {
          const next = source[cursor + 1]!;
          out += DOUBLE_ESCAPES[next] ?? `\\${next}`;
          cursor += 2;
          continue;
        }
        if (ch === quote) {
          closed = true;
          break;
        }
        out += ch;
        cursor += 1;
      }
      if (!closed) {
        skipped += 1;
        at = end + 1;
        continue;
      }
      value = out;
      at = lineEnd(cursor) + 1;
    } else {
      // Bare: to the end of the line, minus a trailing ` # comment`.
      value = source.slice(start, end).replace(/\s+#.*$/u, "").trim();
      at = end + 1;
    }
    if (!ENV_NAME.test(name)) {
      skipped += 1;
      continue;
    }
    values[name] = value;
  }
  return { values, skipped };
};
