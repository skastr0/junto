/**
 * Generated art as sprite references: portraits, kind icons, ledger bands and
 * harness marks come from the same pure generators the DOM uses, so the two
 * cannot drift. The shell rasterizes the SVG at the size the sprite shows
 * (architecture section 9); each key names content and nothing else.
 */

import { portraitConfigKey, portraitDetailFor, portraitSvg, type PortraitConfig } from "@shared/agent-portrait";
import { kindIconSvg, type KindIconKind } from "@shared/kind-icon";
import { EXPRESSION_FACES, type PortraitExpression } from "@shared/portrait-expression";
import type { ThemeMode } from "@shared/theme";
import { bandBackground, kindBandLayers, BAND_BOX, type BandLayer, type KindLedger, type KindState } from "../../lib/kind-band";
import { markTileFor } from "../../lib/harness-icons";
import type { SpriteRef } from "../contract";

const bounded = <V>(cache: Map<string, V>, key: string, make: () => V, limit = 4000): V => {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  if (cache.size >= limit) cache.clear();
  const value = make();
  cache.set(key, value);
  return value;
};

const portraits = new Map<string, string>();

/** A seat's portrait: round, detail by size, the expression the mood picked. */
export const portraitSprite = (
  seed: string,
  mode: ThemeMode,
  px: number,
  expression: PortraitExpression = "resting",
  config?: PortraitConfig,
): SpriteRef => {
  const detail = portraitDetailFor(px);
  const key = `portrait|${mode}|${detail}|${expression}|${portraitConfigKey(config)}|${seed}`;
  const svg = bounded(portraits, key, () => portraitSvg({ seed, mode, detail, frame: "round", config, face: EXPRESSION_FACES[expression] }));
  return { atlas: "image", key, svg, size: { width: px, height: px } };
};

const icons = new Map<string, string>();

export const kindIconSprite = (kind: KindIconKind, mode: ThemeMode, px: number): SpriteRef => {
  const key = `kind-icon|${mode}|${kind}|${px < 34 ? 0 : px < 72 ? 1 : 2}`;
  const svg = bounded(icons, key, () => kindIconSvg(kind, mode, px));
  return { atlas: "image", key, svg, size: { width: px, height: px } };
};

export type BandSprite = { readonly sprite: SpriteRef; readonly motion?: BandLayer["motion"] };

const bands = new Map<string, ReadonlyArray<BandLayer>>();
const ledgerKey = (ledger: KindLedger | undefined): string => (ledger === undefined ? "" : JSON.stringify(ledger));

/** A kind's ledger band, layer by layer: still layers, then at most one moving one. */
export const bandSprites = (kind: KindIconKind, state: KindState, mode: ThemeMode, ledger?: KindLedger): ReadonlyArray<BandSprite> => {
  const key = `band|${mode}|${kind}|${state}|${ledgerKey(ledger)}`;
  const layers = bounded(bands, key, () => kindBandLayers(kind, state, mode, ledger), 800);
  return layers.map((layer, index) => ({
    sprite: { atlas: "image", key: `${key}|${index}`, svg: layer.svg, size: { width: BAND_BOX, height: BAND_BOX } },
    ...(layer.motion ? { motion: layer.motion } : {}),
  }));
};

export { bandBackground };

const harness = new Map<string, SpriteRef>();

const esc = (value: string): string => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * The harness mark on the portrait's badge: the tile `HarnessMark` draws (the
 * hue at 14% behind the vendor mark in the hue), as one SVG at `size`.
 */
export const harnessSprite = (agent: string | undefined, size: number): SpriteRef => {
  const key = `harness|${agent ?? ""}|${size}`;
  return bounded(harness, key, () => {
    const tile = markTileFor(agent, undefined);
    const hue = esc(tile.hue);
    const radius = Math.round((size * 8) / 28);
    const inner = Math.round((size * 15) / 28);
    const at = (size - inner) / 2;
    const alpha = tile.known ? 0.14 : 0.1;
    const frame = `<rect x="0.5" y="0.5" width="${size - 1}" height="${size - 1}" rx="${radius}" fill="${hue}" fill-opacity="${alpha}" stroke="${hue}" stroke-opacity="0.28"/>`;
    const glyph = tile.imageSrc
      ? `<image href="${esc(tile.imageSrc)}" x="${at}" y="${at}" width="${inner}" height="${inner}"/>`
      : tile.paths.length > 0
        ? `<svg viewBox="${esc(tile.viewBox)}" x="${at}" y="${at}" width="${inner}" height="${inner}" fill="${hue}">${tile.paths
            .map((d) => `<path d="${esc(d)}" fill-rule="${tile.fillRule}" clip-rule="${tile.fillRule}"/>`)
            .join("")}</svg>`
        : `<text x="${size / 2}" y="${size / 2}" text-anchor="middle" dominant-baseline="central" fill="${hue}" font-size="${Math.round((size * 11) / 28)}" font-weight="650">${esc(tile.displayName.charAt(0).toUpperCase())}</text>`;
    return { atlas: "image", key, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${frame}${glyph}</svg>`, size: { width: size, height: size } } as SpriteRef;
  });
};
