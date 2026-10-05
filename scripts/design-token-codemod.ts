#!/usr/bin/env bun
/**
 * Design token codemod: moves hardcoded type sizes, tracking, leading and
 * corner radii onto the token scale (src/shared/theme/type.ts, shape.ts).
 *
 * The scale is short on purpose, so a legacy value that has no step of its
 * own moves to the nearest one. This file is the one mapping: every slice
 * converts through it, so 13px lands on the same token everywhere.
 *
 *   bun run tokens:convert <file or folder>...        rewrite in place
 *   bun run tokens:convert --dry <file or folder>...  report only
 *
 * It rewrites css declarations and Tailwind arbitrary classes. It leaves
 * alone, and lists: inline style objects (fontSize: 12 may feed xterm or a
 * canvas, not css), lengths outside the scale's reach, and font stacks.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

// Each table lists the top of a step's reach: a value maps to the first step
// whose limit it does not exceed. Ties were settled by hand, once, here.

/** px. 13 sits between two steps and goes down: dense chrome stays dense. */
const TEXT_STEPS: ReadonlyArray<readonly [number, string]> = [
  [8.25, "micro"],
  [9.25, "caption"],
  [10.25, "label"],
  [11.25, "body"],
  [13, "body-lg"],
  [16, "title"],
  [20, "display"],
  [26, "hero"],
];

/** em. */
const TRACKING_STEPS: ReadonlyArray<readonly [number, string]> = [
  [0.015, "flat"],
  [0.055, "soft"],
  [0.105, "label"],
  [0.2, "eyebrow"],
];

/** Unitless. 1 and below are resets, not a rhythm: left alone. */
const LEADING_STEPS: ReadonlyArray<readonly [number, string]> = [
  [1.275, "compact"],
  [1.375, "dense"],
  [1.525, "body"],
  [1.75, "open"],
];

/** px. 5 joins 6 (buttons and fields were split across both), 7 and 9 join 8, 10 joins 12. */
const RADIUS_STEPS: ReadonlyArray<readonly [number, string]> = [
  [4.5, "sm"],
  [6.5, "md"],
  [9.5, "lg"],
  [14, "xl"],
];
const PILL_FROM = 99;

const step = (steps: ReadonlyArray<readonly [number, string]>, value: number, min: number): string | undefined =>
  value < min ? undefined : steps.find(([limit]) => value <= limit)?.[1];

export const textToken = (px: number): string | undefined => step(TEXT_STEPS, px, 6);
export const trackingToken = (em: number): string | undefined => step(TRACKING_STEPS, em, -0.015);
export const leadingToken = (ratio: number): string | undefined => step(LEADING_STEPS, ratio, 1.01);
export const radiusToken = (px: number): string | undefined =>
  px >= PILL_FROM ? "pill" : step(RADIUS_STEPS, px, 0.5);

const num = (raw: string): number => Number(raw.startsWith(".") ? `0${raw}` : raw.replace(/^-\./, "-0."));

export type Conversion = {
  readonly text: string;
  /** How many literals became tokens. */
  readonly converted: number;
  /** How many of those changed value on the way (the rest were exact). */
  readonly moved: number;
  /** Literals the codemod will not decide; a person does. */
  readonly left: readonly string[];
};

const TOKEN_VALUES: Record<string, Record<string, number>> = {
  text: { micro: 8, caption: 9, label: 10, body: 11, "body-lg": 12, title: 14, display: 18, hero: 24 },
  tracking: { flat: 0, soft: 0.04, label: 0.08, eyebrow: 0.14 },
  leading: { compact: 1.2, dense: 1.35, body: 1.45, open: 1.6 },
  radius: { sm: 4, md: 6, lg: 8, xl: 12, pill: 999 },
};

const convertSource = (source: string, isCss: boolean): Conversion => {
  let converted = 0;
  let moved = 0;
  const left: string[] = [];
  const took = (family: string, token: string, value: number): void => {
    converted += 1;
    if (family === "radius" && token === "pill") return;
    if (Math.abs(TOKEN_VALUES[family]![token]! - value) > 1e-9) moved += 1;
  };

  let text = source;
  if (isCss) {
    text = text.replace(/(?<![\w-])font-size:(\s*)(-?\d*\.?\d+)px(?=\s*(?:!important\s*)?[;}])/g, (all, gap: string, raw: string) => {
      const token = textToken(num(raw));
      if (!token) return left.push(all.trim()), all;
      took("text", token, num(raw));
      return `font-size:${gap}var(--text-${token})`;
    });
    text = text.replace(/(?<![\w-])letter-spacing:(\s*)(-?\d*\.?\d+)em(?=\s*(?:!important\s*)?[;}])/g, (all, gap: string, raw: string) => {
      const token = trackingToken(num(raw));
      if (!token) return left.push(all.trim()), all;
      took("tracking", token, num(raw));
      return `letter-spacing:${gap}var(--tracking-${token})`;
    });
    text = text.replace(/(?<![\w-])line-height:(\s*)(\d*\.?\d+)(?=\s*(?:!important\s*)?[;}])/g, (all, gap: string, raw: string) => {
      const token = leadingToken(num(raw));
      if (!token) return all;
      took("leading", token, num(raw));
      return `line-height:${gap}var(--leading-${token})`;
    });
    // Each corner of a shorthand maps on its own; 0 and percentages stay.
    text = text.replace(/(?<![\w])(border(?:-[a-z]+){0,2}-radius:)([^;{}]+)/g, (all, prop: string, value: string) => {
      if (/var\(|calc\(|\//.test(value)) return all;
      let failed = false;
      const next = value.replace(/(?<![\w.-])(\d*\.?\d+)px\b/g, (length, raw: string) => {
        const token = radiusToken(num(raw));
        if (!token) return (failed = true), length;
        took("radius", token, num(raw));
        return `var(--radius-${token})`;
      });
      if (failed) return left.push(all.trim()), all;
      return `${prop}${next}`;
    });
    return { text, converted, moved, left };
  }

  text = text.replace(/\btext-\[(\d*\.?\d+)px\]/g, (all, raw: string) => {
    const token = textToken(num(raw));
    if (!token) return left.push(all), all;
    took("text", token, num(raw));
    return `text-${token}`;
  });
  text = text.replace(/\btracking-\[(-?\d*\.?\d+)em\]/g, (all, raw: string) => {
    const token = trackingToken(num(raw));
    if (!token) return left.push(all), all;
    took("tracking", token, num(raw));
    return `tracking-${token}`;
  });
  text = text.replace(/\bleading-\[(\d*\.?\d+)\]/g, (all, raw: string) => {
    const token = leadingToken(num(raw));
    if (!token) return left.push(all), all;
    took("leading", token, num(raw));
    return `leading-${token}`;
  });
  text = text.replace(/\b(rounded(?:-[a-z]{1,2})?)-\[(\d*\.?\d+)px\]/g, (all, prefix: string, raw: string) => {
    const token = radiusToken(num(raw));
    if (!token) return left.push(all), all;
    took("radius", token, num(raw));
    return `${prefix}-${token}`;
  });
  for (const match of text.matchAll(/\b(?:fontSize|letterSpacing|lineHeight|borderRadius):\s*["'`]?[\d.]+\w*/g)) {
    left.push(match[0]);
  }
  return { text, converted, moved, left };
};

/** Convert one file's text. `ext` picks the css or the component rules. */
export const convert = (source: string, ext: string): Conversion => convertSource(source, ext === ".css");

const collect = (target: string, out: string[]): void => {
  if (statSync(target).isDirectory()) {
    for (const entry of readdirSync(target)) collect(path.join(target, entry), out);
  } else if (/\.(css|tsx)$/.test(target) && !target.endsWith("theme.generated.css")) {
    out.push(target);
  }
};

const main = (): void => {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const targets = args.filter((arg) => !arg.startsWith("--"));
  if (targets.length === 0) {
    console.error("usage: bun run tokens:convert [--dry] <file or folder>...");
    process.exit(2);
  }
  const files: string[] = [];
  for (const target of targets) collect(target, files);

  let converted = 0;
  let moved = 0;
  for (const file of files.sort()) {
    const source = readFileSync(file, "utf8");
    const result = convert(source, path.extname(file));
    if (result.converted === 0 && result.left.length === 0) continue;
    converted += result.converted;
    moved += result.moved;
    if (!dry && result.text !== source) writeFileSync(file, result.text);
    console.log(`${file}: ${result.converted} to tokens (${result.moved} changed value)`);
    for (const literal of result.left) console.log(`    left literal: ${literal}`);
  }
  console.log(`\n${dry ? "would convert" : "converted"} ${converted} literals, ${moved} of them changed value`);
};

if (import.meta.main) main();
