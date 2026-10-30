/**
 * No one-sided accent border. Operator rule (Product region, 2026-10-29): no
 * colored left, right, top or bottom edge, stripe or one-side inset shadow
 * marks a selected row, a card or a callout. State shows as a full border, a
 * background tint, weight or an icon. A selected row is a tint (Cmd+K's
 * --color-overlay-2); a callout is a full 1px border in its hue at about 30%
 * plus a tint at about 8%.
 *
 * The scan reads every renderer stylesheet and the inline styles and Tailwind
 * classes in renderer TSX. Neutral edges (stroke, overlay, ink grays) pass:
 * dividers and quote rules are structure, not accent. KEPT lists the colored
 * one-side edges that are not state on a row, card or callout (a caret, a
 * spinner arc, a link underline, a tab indicator), each with its reason.
 * Adding to KEPT needs product-design's review, named in the commit.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const RENDERER = "src/renderer";

const filesUnder = (dir: string, ext: RegExp): string[] =>
  readdirSync(join(root, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) return filesUnder(rel, ext);
    return ext.test(name) && !/\.(?:test|spec)\.tsx?$/.test(name) ? [rel] : [];
  });

/** Gray tokens: an edge in these is a divider or a quote rule, never accent. */
const NEUTRAL_VAR =
  /^--(?:color-(?:stroke|stroke-hi|overlay-\d|ground|raise|raise-2|inset|well|ink|ink-2|dim|faint|steel|umbra|shadow-\d|backdrop)|deck-line)$/;
const NEUTRAL_WORD = /^(?:transparent|currentcolor|inherit|initial|unset|none|0)$/i;
const LITERAL_COLOR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|lab|lch|color)\(/i;

/** True when the value paints in a hue: a non-gray token or a literal color. */
const isColored = (value: string): boolean => {
  const vars = [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]!);
  if (vars.some((name) => !NEUTRAL_VAR.test(name))) return true;
  const withoutMix = value.replace(/color-mix\(\s*in\s+\w+\s*,/gi, "(");
  return LITERAL_COLOR.test(withoutMix);
};

type Side = "left" | "right" | "top" | "bottom";
type Edge = { readonly file: string; readonly line: number; readonly selector: string; readonly side: Side; readonly text: string };

const LENGTH = /^-?(?:\d*\.?\d+)(?:px|rem|em)?$/;
const isZero = (token: string | undefined): boolean => token === undefined || /^-?0(?:\.0+)?(?:px|rem|em)?$/.test(token);

/** Split on commas that are not inside parentheses. */
const splitTop = (value: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
};

/** Tokens of one shadow, parentheses kept whole. */
const tokens = (value: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const c of value) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (/\s/.test(c) && depth === 0) {
      if (current) out.push(current);
      current = "";
    } else current += c;
  }
  if (current) out.push(current);
  return out;
};

/** The side a one-side inset shadow paints, if it is one and it is colored. */
const insetStripe = (value: string): Side | undefined => {
  for (const shadow of splitTop(value)) {
    const parts = tokens(shadow);
    if (!parts.includes("inset")) continue;
    const lengths = parts.filter((part) => LENGTH.test(part));
    const [x, y, blur, spread] = lengths;
    if (!isZero(blur) || !isZero(spread)) continue;
    const xOn = !isZero(x);
    const yOn = !isZero(y);
    if (xOn === yOn) continue;
    if (!isColored(parts.filter((part) => !LENGTH.test(part) && part !== "inset").join(" "))) continue;
    if (xOn) return x!.startsWith("-") ? "right" : "left";
    return y!.startsWith("-") ? "bottom" : "top";
  }
  return undefined;
};

/** The colored one-side edge a declaration paints, if any. */
const edgeOf = (property: string, value: string): Side | undefined => {
  const side = /^border-(left|right|top|bottom)(?:-(color))?$/.exec(property);
  if (side) {
    const [, name, colorOnly] = side;
    if (colorOnly === undefined) {
      const parts = tokens(value);
      const width = parts.find((part) => LENGTH.test(part) || /^(?:thin|medium|thick)$/.test(part));
      if (parts.some((part) => /^(?:none|hidden)$/.test(part)) || (width !== undefined && isZero(width))) return undefined;
      if (parts.every((part) => NEUTRAL_WORD.test(part) || LENGTH.test(part) || /^(?:solid|dashed|dotted|double)$/.test(part))) return undefined;
    }
    return isColored(value) ? (name as Side) : undefined;
  }
  if (property === "box-shadow") return insetStripe(value);
  return undefined;
};

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));

const cssEdges = (file: string): Edge[] => {
  const css = stripComments(readFileSync(join(root, file), "utf8"));
  const lineAt = (index: number): number => css.slice(0, index).split("\n").length;
  const edges: Edge[] = [];
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1]!.trim().replace(/\s+/g, " ");
    if (selector.startsWith("@")) continue;
    const bodyStart = rule.index! + rule[0].indexOf("{") + 1;
    let offset = 0;
    for (const declaration of rule[2]!.split(";")) {
      const at = bodyStart + offset;
      offset += declaration.length + 1;
      const colon = declaration.indexOf(":");
      if (colon < 0) continue;
      const property = declaration.slice(0, colon).trim().toLowerCase();
      const value = declaration.slice(colon + 1).replace(/!important/g, "").trim();
      const side = edgeOf(property, value);
      if (side === undefined) continue;
      const lead = declaration.length - declaration.trimStart().length;
      edges.push({ file, line: lineAt(at + lead), selector, side, text: `${property}: ${value}` });
    }
  }
  return edges;
};

const TAILWIND_SIDE_COLOR = /\bborder-[lrtb]-(?!\d|\[?0|stroke|overlay|transparent|ground|raise|inset)[a-z][\w-]*/g;
const TAILWIND_INSET = /\bshadow-\[inset_([^\]]+)\]/g;
const INLINE_SIDE = /\bborder(Left|Right|Top|Bottom)(?:Color)?\s*:\s*([^,}\n]+)/g;

const tsxEdges = (file: string): Edge[] => {
  const lines = readFileSync(join(root, file), "utf8").split("\n");
  const edges: Edge[] = [];
  lines.forEach((text, index) => {
    const at = (side: Side, what: string) =>
      edges.push({ file, line: index + 1, selector: "(tsx)", side, text: what.trim().slice(0, 140) });
    for (const match of text.matchAll(TAILWIND_SIDE_COLOR)) {
      const letter = match[0][7] as "l" | "r" | "t" | "b";
      at(({ l: "left", r: "right", t: "top", b: "bottom" } as const)[letter], match[0]);
    }
    for (const match of text.matchAll(TAILWIND_INSET)) {
      const side = insetStripe(`inset ${match[1]!.replace(/_/g, " ")}`);
      if (side !== undefined) at(side, match[0]);
    }
    for (const match of text.matchAll(INLINE_SIDE)) {
      const value = match[2]!;
      // A conditional style names its hue in a helper; any non-gray name counts.
      if (isColored(value) || /\b(?:HUE|withAlpha|accent|amber|cyan|crimson)\b/.test(value)) {
        at(match[1]!.toLowerCase() as Side, match[0]);
      }
    }
  });
  return edges;
};

type Kept = { readonly file: string; readonly selector: RegExp; readonly reason: string };

/** Colored one-side edges that are not state on a row, card or callout. */
const KEPT: ReadonlyArray<Kept> = [
  { file: "src/renderer/components/ui/code-editor.css", selector: /\.cm-cursor$/, reason: "the text caret" },
  { file: "src/renderer/components/artifacts/live-markdown.css", selector: /\.cm-cursor$/, reason: "the text caret" },
  { file: "src/renderer/styles.css", selector: /session-load__spinner/, reason: "a spinner arc" },
  { file: "src/renderer/styles.css", selector: /^\.note-md__link(?::hover)?$/, reason: "a link underline" },
  { file: "src/renderer/components/work/artifact-markdown.css", selector: /^\.artifact-markdown a(?::hover)?$/, reason: "a link underline" },
  { file: "src/renderer/components/artifacts/live-markdown.css", selector: /\.cm-md-link$|artifact-document__anchor$/, reason: "a link or anchor underline" },
  { file: "src/renderer/components/ui/mention-combobox.css", selector: /^\.mention-combobox__chip$/, reason: "an inline mention chip underline, a link in running text" },
  { file: "src/renderer/components/artifacts/artifact-sheet.css", selector: /^\.junto-artifact-sheet__link$/, reason: "a link underline in a cell" },
  { file: "src/renderer/components/nodes/spine-card.css", selector: /^\.spine__row\[data-tone="(?:crimson|amber)"\]::before$/, reason: "the spine's branch tick, a drawn tree line, not an edge of the row" },
];

/**
 * Known offenders with a fix assigned (census artifact 01M6521DHWMD7WHCHDJR0ZXQMA).
 * This list only shrinks: product-design removes an entry once its fix lands,
 * and a new edge never goes here. An entry that matches nothing is tolerated
 * so a fix can land before the entry goes.
 */
const PENDING: ReadonlyArray<{ readonly file: string; readonly selector: RegExp; readonly owner: string }> = [
];

const kept = (edge: Edge): boolean =>
  [...KEPT, ...PENDING].some((entry) => entry.file === edge.file && entry.selector.test(edge.selector));

const allEdges = (): Edge[] => [
  ...filesUnder(RENDERER, /\.css$/).flatMap(cssEdges),
  ...filesUnder(RENDERER, /\.tsx$/).flatMap(tsxEdges),
];

describe("no one-sided accent border", () => {
  it("finds no colored one-side edge outside the kept list", () => {
    const found = allEdges()
      .filter((edge) => !kept(edge))
      .map((edge) => `${relative(root, join(root, edge.file))}:${edge.line} ${edge.selector} (${edge.side}) ${edge.text}`);
    expect(found).toEqual([]);
  });

  it("keeps no entry that no longer matches anything", () => {
    const edges = allEdges();
    const stale = KEPT
      .filter((entry) => !edges.some((edge) => edge.file === entry.file && entry.selector.test(edge.selector)))
      .map((entry) => `${entry.file} ${String(entry.selector)}`);
    expect(stale).toEqual([]);
  });

  it("catches the shapes the rule names", () => {
    expect(edgeOf("border-left", "2px solid var(--color-crimson)")).toBe("left");
    expect(edgeOf("border-bottom", "1px solid color-mix(in oklab, var(--color-amber) 35%, transparent)")).toBe("bottom");
    expect(edgeOf("border-left-color", "var(--color-cyan)")).toBe("left");
    expect(edgeOf("box-shadow", "inset 2px 0 0 var(--color-cyan)")).toBe("left");
    expect(edgeOf("box-shadow", "inset 0 -2px 0 var(--color-amber)")).toBe("bottom");
    expect(edgeOf("box-shadow", "0 1px 2px var(--color-shadow-1), inset 0 2px 0 var(--mark)")).toBe("top");
  });

  it("lets structure and full rings through", () => {
    expect(edgeOf("border-left", "2px solid var(--color-stroke-hi)")).toBeUndefined();
    expect(edgeOf("border-bottom", "1px solid color-mix(in srgb, var(--color-stroke) 60%, transparent)")).toBeUndefined();
    expect(edgeOf("border-left", "2px solid transparent")).toBeUndefined();
    expect(edgeOf("border-right", "0")).toBeUndefined();
    expect(edgeOf("box-shadow", "inset 0 0 0 2px var(--color-cyan)")).toBeUndefined();
    expect(edgeOf("box-shadow", "inset 0 -1px 0 var(--color-overlay-4)")).toBeUndefined();
    expect(edgeOf("border", "1px solid var(--color-amber)")).toBeUndefined();
  });
});
