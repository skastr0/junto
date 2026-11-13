#!/usr/bin/env bun
/**
 * Canvas colour gate. Under src/window/canvas/ a colour comes from the theme
 * projection (themeGpu(mode), or a var(--color-*) in the rare css file), never
 * from a literal: no hex, no rgb()/hsl()/oklch()/color() function, no named
 * colour. The folder is new, so the rule holds from its first file with no
 * baseline — anything found is a violation.
 *
 * Colours the engine legitimately packs into integers (a u32 for a vertex
 * attribute, an alpha mask) are numbers, not literals of this kind, and pass.
 * In scripts, named colours inside strings are not distinguished from other
 * words, so the named-colour rule applies to css files only; hex and the
 * colour functions are refused everywhere.
 *
 *   bun run lint:canvas-theme          check
 *
 * Exit 0 = clean; exit 1 = violations with file and line.
 */
import { readdirSync, readFileSync, type Dirent } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOT = path.join(ROOT, "src/window/canvas");

const EXTENSIONS = new Set([".ts", ".tsx", ".css"]);

// CSS Color 4 function forms. A call whose arguments name a var(--*) or a
// keyword (color-mix(in oklab, var(--color-x) 40%, transparent)) is the
// themed idiom, not a literal, and passes.
const COLOR_FN =
  /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\s*\(/g;

// Hex colours. Script files take 6- and 8-digit forms only and never after a
// dot or word character, so `this.#facade` (a private field) is not a colour;
// css files take every width, including the 3/4-digit shorthands.
const hexRe = (script: boolean): RegExp =>
  script
    ? /(?<![\w$.])#[0-9a-fA-F]{8}\b(?![\w-])|(?<![\w$.])#[0-9a-fA-F]{6}\b(?![\w-])/g
    : /#[0-9a-fA-F]{3,8}\b(?![\w-])/g;

// CSS named colours, checked inside declaration values only (see below).
// Keywords that are not colours — transparent, currentColor, inherit,
// initial, unset, none — stay legal.
const NAMED_COLOUR =
  /\b(?:aliceblue|antiquewhite|aqua|aquamarine|azure|beige|bisque|black|blanchedalmond|blue|blueviolet|brown|burlywood|cadetblue|chartreuse|chocolate|coral|cornflowerblue|cornsilk|crimson|cyan|darkblue|darkcyan|darkgoldenrod|darkgray|darkgreen|darkgrey|darkkhaki|darkmagenta|darkolivegreen|darkorange|darkorchid|darkred|darksalmon|darkseagreen|darkslateblue|darkslategray|darkslategrey|darkturquoise|darkviolet|deeppink|deepskyblue|dimgray|dimgrey|dodgerblue|firebrick|floralwhite|forestgreen|fuchsia|gainsboro|ghostwhite|gold|goldenrod|gray|green|greenyellow|grey|honeydew|hotpink|indianred|indigo|ivory|khaki|lavender|lavenderblush|lawngreen|lemonchiffon|lightblue|lightcoral|lightcyan|lightgoldenrodyellow|lightgray|lightgreen|lightgrey|lightpink|lightsalmon|lightseagreen|lightskyblue|lightslategray|lightslategrey|lightsteelblue|lightyellow|lime|limegreen|linen|magenta|maroon|mediumaquamarine|mediumblue|mediumorchid|mediumpurple|mediumseagreen|mediumslateblue|mediumspringgreen|mediumturquoise|mediumvioletred|midnightblue|mintcream|mistyrose|moccasin|navajowhite|navy|oldlace|olive|olivedrab|orange|orangered|orchid|palegoldenrod|palegreen|paleturquoise|palevioletred|papayawhip|peachpuff|peru|pink|plum|powderblue|purple|rebeccapurple|red|rosybrown|royalblue|saddlebrown|salmon|sandybrown|seagreen|seashell|sienna|silver|skyblue|slateblue|slategray|slategrey|snow|springgreen|steelblue|tan|teal|thistle|tomato|turquoise|violet|wheat|white|whitesmoke|yellow|yellowgreen)\b/i;

const THEMED = /var\(--|currentColor|transparent|inherit\b/;

/** The text of a function call starting at `open` (the index of `(`), to its
 *  matching close — or the rest of the file when unbalanced. */
const callBody = (text: string, open: number): string => {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
};

const stripComments = (source: string, css: boolean): string => {
  const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, (c) =>
    c.replace(/[^\n]/g, " "),
  );
  if (css) return noBlock;
  // Line comments, but not the // of a URL or a string like "a // b" is rare
  // enough in canvas code that the occasional over-strip is acceptable.
  return noBlock.replace(/(^|[^:"'`])\/\/[^\n]*/g, (c, pre: string) =>
    pre + " ".repeat(c.length - pre.length),
  );
};

export type CanvasColourHit = {
  readonly line: number;
  readonly text: string;
};

/** Every colour literal in one file's text. */
export const scanCanvasFile = (source: string, ext: string): CanvasColourHit[] => {
  const css = ext === ".css";
  const text = stripComments(source, css);
  const hits: CanvasColourHit[] = [];
  const push = (index: number, found: string): void => {
    hits.push({
      line: text.slice(0, index).split("\n").length,
      text: found.trim(),
    });
  };

  for (const match of text.matchAll(COLOR_FN)) {
    const open = match.index + match[0].length - 1;
    const body = callBody(text, open);
    if (THEMED.test(body)) continue;
    push(match.index, match[0] + body.slice(0, 60));
  }
  for (const match of text.matchAll(hexRe(!css))) {
    push(match.index, match[0]);
  }
  if (css) {
    // Named colours only as a declaration's value: `color: red`,
    // `border: 1px solid red`. Selectors and strings stay untouched; a value
    // built on var(--*) or color-mix() has its themed parts removed first, so
    // `box-shadow: var(--shadow-x), 0 0 0 2px red` still fails on the red.
    for (const decl of text.matchAll(/([a-zA-Z-]+)\s*:\s*([^;{}]+)[;}]?/g)) {
      const rest = decl[2]!
        .replace(/var\([^)]*\)|color-mix\([^)]*\)/g, " ")
        .replace(/"[^"]*"|'[^']*'/g, " ");
      const named = NAMED_COLOUR.exec(rest);
      if (named) push(decl.index, `${decl[1]}: …${named[0]}…`);
    }
  }
  return hits;
};

const walk = (dir: string, out: string[]): void => {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // the folder may not exist yet on a fresh checkout
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(path.extname(entry.name))) out.push(full);
  }
};

const main = (): void => {
  const files: string[] = [];
  walk(SCAN_ROOT, files);
  let failed = false;
  for (const full of files.sort()) {
    const rel = path.relative(ROOT, full).split(path.sep).join("/");
    const hits = scanCanvasFile(readFileSync(full, "utf8"), path.extname(full));
    for (const hit of hits) {
      failed = true;
      console.error(`${rel}:${hit.line}  ${hit.text}`);
    }
  }
  if (failed) {
    console.error(
      "\nlint:canvas-theme: a colour literal under src/window/canvas/. Take it from themeGpu(mode) or a var(--color-*); never adjust a colour in canvas code.",
    );
    process.exit(1);
  }
  console.log(`lint:canvas-theme ok (${files.length} files)`);
};

if (import.meta.main) main();
