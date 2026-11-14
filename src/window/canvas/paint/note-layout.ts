/**
 * Note typesetting (architecture section 8, the one place with real layout):
 * `parseBlocks` and `parseInline` in, positioned quads out, for a width. The
 * numbers are the CSS rules in `styles.css` (.note-md) and `spine-card.css`
 * (the callout's overrides), read once into the table below. At mid a note
 * shows its first block only, so the first block's quads carry near and mid
 * and every later block near alone.
 */

import { TEXT_SIZES } from "@shared/theme";
import { parseBlocks, parseInline } from "../../lib/note-markdown";
import type { FontRole, PaintEnv, Quad, QuadStyle, Rect, TextRun } from "../contract";
import { TIER_BIT } from "../contract";
import { at, shape, sprite, text, tok } from "./refs";

type Blocks = ReturnType<typeof parseBlocks>;
type Block = Blocks[number];
type Inline = ReturnType<typeof parseInline>[number];

const NEAR_MID = TIER_BIT.near | TIER_BIT.mid;
const NEAR = TIER_BIT.near;

/** `.note-md` overrides the callout's inherited 11/1.6 with 12/1.55 (styles.css:1914-1917). */
export const NOTE_SIZE = Number.parseFloat(TEXT_SIZES["body-lg"] ?? "12");
export const NOTE_LEADING = 1.55;
const TITLE_SIZE = Number.parseFloat(TEXT_SIZES.title);

type Face = {
  readonly font: FontRole;
  readonly size: number;
  readonly weight: number;
  readonly leading: number;
  readonly tracking?: number;
  readonly upper?: boolean;
  readonly italic?: boolean;
  readonly ink: string;
};

const BODY: Face = { font: "mono", size: NOTE_SIZE, weight: 400, leading: NOTE_LEADING, ink: "ink-2" };

type Style = { readonly strong?: boolean; readonly em?: boolean; readonly code?: boolean; readonly href?: string };

type Piece = { readonly text: string; readonly style: Style };

const flatten = (tokens: ReadonlyArray<Inline>, style: Style = {}): ReadonlyArray<Piece> =>
  tokens.flatMap((token): ReadonlyArray<Piece> => {
    switch (token.kind) {
      case "text":
        return [{ text: token.value, style }];
      case "code":
        return [{ text: token.value, style: { ...style, code: true } }];
      case "strong":
        return flatten(token.children, { ...style, strong: true });
      case "em":
        return flatten(token.children, { ...style, em: true });
      case "link":
        return flatten(token.children, { ...style, href: token.href });
      case "image":
        return [{ text: token.src === "" ? "[image blocked]" : (token.alt === "" ? "[image]" : token.alt), style }];
    }
  });

const runOf = (face: Face, style: Style, value: string, width: number): TextRun => ({
  text: value,
  font: face.font,
  size: style.code ? face.size * 0.9 : face.size,
  weight: style.strong ? 600 : face.weight,
  leading: face.leading,
  truncate: "none",
  width,
  halo: true,
  ...(face.tracking !== undefined ? { tracking: face.tracking } : {}),
  ...(face.upper ? { upper: true } : {}),
  ...(face.italic || style.em ? { italic: true } : {}),
});

const inkOf = (face: Face, style: Style): string =>
  style.href !== undefined ? "amber" : style.code ? "amber" : style.strong || style.em ? "ink" : face.ink;

type Seg = { readonly style: Style; text: string; x: number; w: number };

/** Greedy wrap of pieces into lines of `width`, preserving the mix of styles. */
const wrap = (pieces: ReadonlyArray<Piece>, face: Face, width: number, env: PaintEnv): ReadonlyArray<ReadonlyArray<Seg>> => {
  const lines: Seg[][] = [[]];
  let x = 0;
  const measure = (style: Style, value: string): number => env.measure(runOf(face, style, value, 4096));
  for (const piece of pieces) {
    for (const part of piece.text.split(/(\s+)/)) {
      if (part === "") continue;
      const space = /^\s+$/.test(part);
      let line = lines[lines.length - 1]!;
      if (space && line.length === 0) continue;
      const w = measure(piece.style, part);
      if (!space && line.length > 0 && x + w > width) {
        lines.push([]);
        line = lines[lines.length - 1]!;
        x = 0;
      }
      const last = line[line.length - 1];
      if (last !== undefined && last.style === piece.style) {
        last.text += part;
        last.w += w;
      } else {
        line.push({ style: piece.style, text: part, x, w });
      }
      x += w;
    }
  }
  return lines.filter((line, i) => line.length > 0 || i === 0);
};

type Out = { readonly quads: Quad[]; y: number };

/** One wrapped paragraph of inline pieces at `x0`; returns its height. */
const typeset = (
  out: Quad[],
  key: string,
  pieces: ReadonlyArray<Piece>,
  face: Face,
  x0: number,
  y0: number,
  width: number,
  tiers: number,
  env: PaintEnv,
): number => {
  const lineH = face.size * face.leading;
  const lines = wrap(pieces, face, width - x0, env);
  lines.forEach((line, li) => {
    const y = y0 + li * lineH;
    line.forEach((seg, si) => {
      // Trailing spaces carry no ink.
      const value = si === line.length - 1 ? seg.text.replace(/\s+$/, "") : seg.text;
      if (value === "") return;
      const w = Math.min(seg.w, width - x0 - seg.x);
      const k = `${key}.${li}.${si}`;
      const rect = at(x0 + seg.x, y, w, lineH);
      if (seg.style.code) {
        const pad = face.size * 0.32;
        out.push(
          shape(
            { key: `${k}.box`, z: 10, rect: at(rect.x - pad, y + lineH * 0.1, w + pad * 2, lineH * 0.8) },
            { fill: { kind: "flat", color: tok("well") }, stroke: { color: tok("stroke"), width: 1 } },
            { tiers, radii: 3 },
          ),
        );
      }
      out.push(
        text({ key: k, z: 11, rect }, { ink: tok(inkOf(face, seg.style)) }, {
          tiers,
          text: runOf(face, seg.style, value, Math.max(1, w)),
          ...(seg.style.href !== undefined ? { part: { kind: "noteLink", href: seg.style.href } as const } : {}),
        }),
      );
      if (seg.style.href !== undefined) {
        out.push(
          shape({ key: `${k}.rule`, z: 10, rect: at(rect.x, y + lineH - 1, w, 1) }, { fill: { kind: "flat", color: tok("main", 0.35) } }, { tiers }),
        );
      }
    });
  });
  return lines.length * lineH;
};

const headingFace = (level: 1 | 2 | 3, first: boolean, cartouche: boolean): Face => {
  if (first) {
    // The callout makes a first heading ink, `--text-title`, 600; a leading # is mono.
    return { font: cartouche ? "mono" : "display", size: TITLE_SIZE, weight: 600, leading: 1.2, ink: "ink", ...(cartouche ? {} : { tracking: 0.04 }) };
  }
  if (level === 1) return { font: "display", size: 14, weight: 700, leading: 1.2, tracking: 0.06, upper: true, ink: "ink" };
  if (level === 2) return { font: "display", size: 12.5, weight: 600, leading: 1.2, tracking: 0.05, ink: "ink" };
  return { font: "display", size: 11, weight: 500, leading: 1.2, tracking: 0.08, upper: true, ink: "dim" };
};

export type NoteLayout = {
  readonly quads: ReadonlyArray<Quad>;
  /** Height of the typeset content, in board units. */
  readonly height: number;
  readonly empty: boolean;
};

/**
 * Typeset a note's source for a content box of `width`, its top left at `origin`
 * (card units). Block margins collapse the way CSS sibling margins do.
 */
export const layoutNote = (source: string, width: number, origin: { readonly x: number; readonly y: number }, env: PaintEnv): NoteLayout => {
  const blocks = parseBlocks(source);
  if (blocks.length === 0) {
    const run: TextRun = { text: "empty note", font: "mono", size: 11, weight: 400, italic: true, leading: 1.2, truncate: "end", width, halo: true };
    return {
      quads: [text({ key: "empty", z: 11, rect: at(origin.x, origin.y, width, 11 * 1.2) }, { ink: tok("dim") }, { tiers: NEAR_MID, text: run })],
      height: 11 * 1.2,
      empty: true,
    };
  }
  const quads: Quad[] = [];
  let y = 0;
  let prevBottom = 0;
  blocks.forEach((block: Block, i) => {
    const tiers = i === 0 ? NEAR_MID : NEAR;
    const k = `b${i}`;
    const place = (top: number, bottom: number): number => {
      y += i === 0 ? top : Math.max(prevBottom, top);
      prevBottom = bottom;
      return y;
    };
    const local: Quad[] = [];
    let h = 0;
    const build = (fn: (y0: number) => number, t: number, b: number): void => {
      const y0 = place(t, b);
      h = fn(y0);
    };
    switch (block.kind) {
      case "heading": {
        const first = i === 0;
        const face = headingFace(block.level, first, first && block.level === 1);
        build((y0) => typeset(local, k, flatten(block.children), face, 0, y0, width, tiers, env), 0, face.size * (first && block.level === 1 ? 0.3 : 0.4));
        break;
      }
      case "paragraph":
        build((y0) => typeset(local, k, flatten(block.children), BODY, 0, y0, width, tiers, env), 0, BODY.size * 0.5);
        break;
      case "list": {
        build(
          (y0) => {
            let yy = y0;
            const indent = BODY.size * (block.ordered ? 1.35 : 1.05);
            const gap = BODY.size * 0.32;
            block.items.forEach((item, ii) => {
              if (ii > 0) yy += gap;
              const marker = block.ordered ? `${String(ii + 1)}.` : "–";
              local.push(
                text(
                  { key: `${k}.${ii}.mark`, z: 11, rect: at(0, yy, indent, BODY.size * BODY.leading) },
                  { ink: tok("dim") },
                  { tiers, text: { ...runOf(BODY, {}, marker, indent), ...(block.ordered ? { tabular: true } : {}), truncate: "end" } },
                ),
              );
              yy += typeset(local, `${k}.${ii}`, flatten(item), BODY, indent, yy, width, tiers, env);
            });
            return yy - y0;
          },
          BODY.size * 0.32,
          BODY.size * 0.5,
        );
        break;
      }
      case "code": {
        const face: Face = { font: "mono", size: 10.5, weight: 400, leading: 1.5, ink: "ink-2" };
        build(
          (y0) => {
            const inner = width - 18 - 2;
            let lines = 0;
            const rows: string[] = [];
            for (const raw of block.value.split("\n")) {
              const wrapped = wrap([{ text: raw === "" ? " " : raw, style: {} }], face, inner, env);
              for (const l of wrapped) {
                rows.push(l.map((s) => s.text).join(""));
                lines += 1;
              }
            }
            const lineH = face.size * face.leading;
            const boxH = lines * lineH + 14 + 2;
            local.push(
              shape({ key: `${k}.box`, z: 9, rect: at(0, y0, width, boxH) }, { fill: { kind: "flat", color: tok("well") }, stroke: { color: tok("stroke"), width: 1 } }, { tiers, radii: 5 }),
            );
            rows.forEach((row, ri) => {
              if (row.trim() === "") return;
              local.push(
                text({ key: `${k}.${ri}`, z: 11, rect: at(1 + 9, y0 + 1 + 7 + ri * lineH, inner, lineH) }, { ink: tok("ink-2") }, { tiers, text: { ...runOf(face, {}, row, inner), halo: false } }),
              );
            });
            return boxH;
          },
          0,
          BODY.size * 0.5,
        );
        break;
      }
      case "quote": {
        const size = BODY.size * 1.05;
        const face: Face = { font: "display", size, weight: 400, leading: 1.45, italic: true, ink: "ink" };
        build(
          (y0) => {
            const pad = size * 1.55;
            const yy = y0 + size * 0.1;
            const hh = typeset(local, k, flatten(block.children), face, pad, yy, width, tiers, env);
            const q = size * 1.85;
            local.push(
              text(
                { key: `${k}.mark`, z: 11, rect: at(0, y0 - size * 0.2, q, q) },
                { ink: tok("amber"), opacity: 0.72 },
                { tiers, text: { text: "“", font: "display", size: q, weight: 700, leading: 1, truncate: "none", width: q } },
              ),
            );
            return hh + size * 0.2;
          },
          size * 0.35,
          size * 0.55,
        );
        break;
      }
      case "hr": {
        build(
          (y0) => {
            const mid = y0 + 4;
            local.push(shape({ key: `${k}.rule`, z: 9, rect: at(0, mid, width, 1) }, { fill: { kind: "flat", color: tok("overlay-4") } }, { tiers }));
            const glyph: TextRun = { text: "◦ ◦ ◦", font: "mono", size: 8, weight: 400, tracking: 0.28, leading: 1, truncate: "none", width: 0, align: "center" };
            const gw = env.measure(glyph) + 8 * 0.9;
            local.push(
              shape({ key: `${k}.punch`, z: 10, rect: at((width - gw) / 2, mid - 4, gw, 8) }, { fill: { kind: "flat", color: tok("raise") } }, { tiers }),
              text({ key: `${k}.dots`, z: 11, rect: at((width - gw) / 2, mid - 4, gw, 8) }, { ink: tok("dim") }, { tiers, text: { ...glyph, width: gw } }),
            );
            return 8;
          },
          BODY.size * 0.8,
          BODY.size * 0.8,
        );
        break;
      }
      case "image": {
        build(
          (y0) => {
            if (block.src === "") {
              const run: TextRun = { text: "[image blocked]", font: "mono", size: 10, weight: 400, leading: 1.2, truncate: "end", width };
              local.push(text({ key: `${k}.missing`, z: 11, rect: at(0, y0, width, 12) }, { ink: tok("crimson") }, { tiers, text: run }));
              return 12;
            }
            const boxH = 120;
            const rect: Rect = at(0, y0, width, boxH);
            local.push(
              shape({ key: `${k}.frame`, z: 9, rect }, { fill: { kind: "flat", color: tok("inset") }, stroke: { color: tok("stroke", 0.8), width: 1 } }, { tiers, radii: 3 }),
              sprite({ key: `${k}.image`, z: 10, rect }, { tiers, radii: 3, sprite: { atlas: "media", ref: block.src, fit: "contain" }, part: { kind: "image" } }),
            );
            let hh = boxH;
            if (block.alt !== "") {
              const run: TextRun = { text: block.alt, font: "mono", size: 9, weight: 400, leading: 1.2, truncate: "end", width };
              local.push(text({ key: `${k}.caption`, z: 11, rect: at(0, y0 + boxH + 2, width, 11) }, { ink: tok("faint") }, { tiers, text: run }));
              hh += 13;
            }
            return hh;
          },
          0,
          BODY.size * 0.55,
        );
        break;
      }
    }
    quads.push(...local);
    y += h;
  });
  const moved = quads.map((q) => ({ ...q, rect: { ...q.rect, x: q.rect.x + origin.x, y: q.rect.y + origin.y } }));
  return { quads: moved, height: y, empty: false };
};

