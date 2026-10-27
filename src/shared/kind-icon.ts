import { hexToOklch, oklchToHex, themeRuntime, type Oklch, type ThemeMode } from "./theme";

// Kind icons: one plain icon per non-seat canvas kind (never a face, never a character), drawn in
// the seat portraits' look: a tinted round tile, a flat fill sitting a hair off an ink outline like
// a misregistered print, colours derived from theme tokens (nothing here is a second palette).
// Pure and deterministic: the same kind, mode and size tier always give the same SVG, so an icon
// needs no storage and caches by key. Outline and misregistration scale with the size tier.

export type KindIconKind = "task" | "artifacts" | "automations" | "page" | "terminal" | "git" | "file" | "link" | "note";
type Look = { body: string; accent: string; chroma?: number; lift?: number };
export const KIND_ICON_LOOK: Record<KindIconKind, Look> = {
  task: { body: "green", accent: "amber" },
  artifacts: { body: "violet", accent: "gold" },
  automations: { body: "amber", accent: "cyan" },
  page: { body: "indigo", accent: "cyan" },
  terminal: { body: "steel", accent: "green" },
  git: { body: "orange", accent: "violet" },
  file: { body: "gold", accent: "violet", chroma: 0.75, lift: 0.02 },
  link: { body: "cyan", accent: "orange" },
  note: { body: "gold", accent: "orange", chroma: 1.5 },
};

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const tone = (base: Oklch, l: number, c: number) => oklchToHex({ l, c: Math.max(0, c), h: base.h });
type Palette = Record<"tile" | "halo" | "body" | "shade" | "belly" | "accent" | "accentShade" | "leaf" | "ink" | "shine" | "spark" | "mute", string>;
const RT: Record<string, Record<string, string>> = {};
const palette = (look: Look, mode: ThemeMode): Palette => {
  const rt = (RT[mode] ??= themeRuntime(mode));
  const dark = mode === "dark";
  const tok = (n: string) => hexToOklch(rt[n] ?? rt.amber!);
  const hue = tok(look.body), acc = tok(look.accent), leaf = tok("green"), gold = tok("gold");
  const c = clamp(hue.c * 0.82 * (look.chroma ?? 1), 0.03, 0.14), lift = look.lift ?? 0;
  return {
    tile: dark ? tone(hue, 0.265, c * 0.34) : tone(hue, 0.905, c * 0.3),
    halo: dark ? tone(hue, 0.31, c * 0.42) : tone(hue, 0.945, c * 0.22),
    body: tone(hue, (dark ? 0.81 : 0.815) + lift, c),
    shade: tone(hue, (dark ? 0.7 : 0.71) + lift, c * 1.05),
    belly: tone(hue, (dark ? 0.9 : 0.915) + lift * 0.5, c * 0.45),
    accent: tone(acc, 0.74, clamp(acc.c * 0.9, 0.05, 0.14)),
    accentShade: tone(acc, 0.62, clamp(acc.c * 0.9, 0.05, 0.13)),
    leaf: tone(leaf, 0.72, clamp(leaf.c, 0.06, 0.12)),
    spark: tone(gold, dark ? 0.84 : 0.72, clamp(gold.c, 0.1, 0.14)),
    ink: rt[dark ? "ground" : "ink"]!,
    shine: rt[dark ? "ink" : "raise"]!,
    mute: rt.dim!,
  };
};

type Role = keyof Palette;
type Shape =
  | { k: "p"; d: string; paint: "inked" | "fill" | "line" | "stroke"; color?: Role; w?: number; o?: number }
  | { k: "c"; cx: number; cy: number; r: number; paint: "inked" | "fill" | "line" | "stroke"; color?: Role; w?: number; o?: number };

const rect = (x: number, y: number, w: number, h: number, r: number) => `M${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h - r}Q${x + w} ${y + h} ${x + w - r} ${y + h}H${x + r}Q${x} ${y + h} ${x} ${y + h - r}V${y + r}Q${x} ${y} ${x + r} ${y}Z`;
const poly = (pts: [number, number][]) => `M${pts.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("L")}Z`;
const rot = (x: number, y: number, a: number, cx = 50, cy = 50): [number, number] => { const t = (a * Math.PI) / 180; return [cx + (x - cx) * Math.cos(t) - (y - cy) * Math.sin(t), cy + (x - cx) * Math.sin(t) + (y - cy) * Math.cos(t)]; };

const gearTeeth = (): Shape[] =>
  Array.from({ length: 8 }, (_, i): Shape => ({ k: "p", d: poly([rot(43.5, 18.5, i * 45), rot(56.5, 18.5, i * 45), rot(55, 31, i * 45), rot(45, 31, i * 45)]), paint: "inked", color: "shade" }));

const ICONS: Record<KindIconKind, Shape[]> = {
  task: [
    { k: "p", d: rect(27, 24, 46, 56, 8), paint: "inked", color: "body" },
    { k: "p", d: rect(39, 17, 22, 13, 5), paint: "inked", color: "accent" },
    { k: "c", cx: 50, cy: 23.5, r: 2.6, paint: "fill", color: "ink" },
    { k: "p", d: "M37 55 L46 64 L63 44", paint: "line", color: "leaf", w: 6.5 },
    { k: "p", d: "M37 72 H60", paint: "stroke", color: "shade", w: 3.4 },
  ],
  artifacts: [
    { k: "p", d: poly([[24, 36], [50, 49], [50, 79], [24, 66]]), paint: "inked", color: "body" },
    { k: "p", d: poly([[76, 36], [50, 49], [50, 79], [76, 66]]), paint: "inked", color: "shade" },
    { k: "p", d: poly([[50, 22], [76, 36], [50, 49], [24, 36]]), paint: "inked", color: "belly" },
    { k: "p", d: poly([[44, 25], [63, 35], [56, 38.5], [37, 28.5]]), paint: "inked", color: "accent" },
  ],
  automations: [
    ...gearTeeth(),
    { k: "c", cx: 50, cy: 50, r: 24, paint: "inked", color: "body" },
    { k: "c", cx: 50, cy: 50, r: 10.5, paint: "inked", color: "tile" },
    { k: "c", cx: 50, cy: 50, r: 4.5, paint: "fill", color: "accent" },
  ],
  page: [
    { k: "c", cx: 50, cy: 50, r: 28, paint: "inked", color: "body" },
    { k: "p", d: "M50 22 Q68 36 68 50 Q68 64 50 78 Q32 64 32 50 Q32 36 50 22 Z", paint: "stroke", color: "shade", w: 3 },
    { k: "p", d: "M23 50 H77 M27 36 H73 M27 64 H73", paint: "stroke", color: "shade", w: 3 },
    { k: "p", d: "M60 56 L60 80 L66 74 L71 85 L76 83 L71 72 L79 72 Z", paint: "inked", color: "accent" },
  ],
  terminal: [
    { k: "p", d: rect(20, 26, 60, 48, 8), paint: "inked", color: "body" },
    { k: "p", d: rect(26, 40, 48, 28, 4), paint: "inked", color: "shade" },
    { k: "c", cx: 29, cy: 33, r: 2.2, paint: "fill", color: "accent" },
    { k: "c", cx: 36, cy: 33, r: 2.2, paint: "fill", color: "spark" },
    { k: "p", d: "M33 47 L42 54 L33 61", paint: "line", color: "accent", w: 5 },
    { k: "p", d: "M47 62 H61", paint: "line", color: "accent", w: 5 },
  ],
  git: [
    { k: "p", d: "M37 32 V68", paint: "line", color: "body", w: 6 },
    { k: "p", d: "M37 62 Q37 46 58 44", paint: "line", color: "body", w: 6 },
    { k: "c", cx: 37, cy: 27, r: 9, paint: "inked", color: "accent" },
    { k: "c", cx: 37, cy: 73, r: 9, paint: "inked", color: "leaf" },
    { k: "c", cx: 66, cy: 43, r: 9, paint: "inked", color: "spark" },
  ],
  file: [
    { k: "p", d: poly([[30, 18], [57, 18], [74, 35], [74, 82], [30, 82]]), paint: "inked", color: "body" },
    { k: "p", d: poly([[57, 18], [57, 35], [74, 35]]), paint: "inked", color: "accent" },
    { k: "p", d: "M39 50 H65 M39 61 H65 M39 72 H55", paint: "stroke", color: "shade", w: 3.6 },
  ],
  link: [
    { k: "p", d: rect(18, 32, 38, 22, 11), paint: "line", color: "accent", w: 8 },
    { k: "p", d: rect(44, 46, 38, 22, 11), paint: "line", color: "body", w: 8 },
  ],
  note: [
    { k: "p", d: poly([[24, 24], [76, 24], [76, 62], [62, 78], [24, 78]]), paint: "inked", color: "body" },
    { k: "p", d: poly([[62, 78], [62, 62], [76, 62]]), paint: "inked", color: "accentShade" },
    { k: "c", cx: 50, cy: 24, r: 7, paint: "inked", color: "accent" },
    { k: "c", cx: 48, cy: 22, r: 1.8, paint: "fill", color: "shine" },
    { k: "p", d: "M34 44 H66 M34 54 H58", paint: "stroke", color: "shade", w: 3.6 },
  ],
};

const cache = new Map<string, string>();
/** The kinds that have an icon, in the order the kit shows them. */
export const KIND_ICON_KINDS: readonly KindIconKind[] = ["task", "artifacts", "automations", "page", "terminal", "git", "file", "link", "note"];

/** A kind's icon as an SVG string: round tile, halo, the icon on top. */
export function kindIconSvg(kind: KindIconKind, mode: ThemeMode, size: number): string {
  return decodeURIComponent(kindIconSrc(kind, mode, size).slice("data:image/svg+xml,".length));
}

/** A data URI for a kind's icon: round tile, halo, the icon on top. */
export function kindIconSrc(kind: KindIconKind, mode: ThemeMode, size: number): string {
  const tier = size < 34 ? 0 : size < 72 ? 1 : 2;
  const key = `${kind}|${mode}|${tier}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = palette(KIND_ICON_LOOK[kind], mode);
  const outline = [4.2, 3, 2.4][tier]!, off = [0, 1.4, 1.6][tier]!;
  const draw = (s: Shape): string => {
    const col = p[s.color ?? (s.paint === "stroke" ? "mute" : "body")];
    const geo = (extra: string) => (s.k === "p" ? `<path d="${s.d}" ${extra}/>` : `<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" ${extra}/>`);
    switch (s.paint) {
      case "inked":
        return (off > 0 ? geo(`fill="${col}" transform="translate(${off} ${off * 0.7})"`) + geo(`fill="none" stroke="${p.ink}" stroke-width="${outline}" stroke-linejoin="round"`) : geo(`fill="${col}" stroke="${p.ink}" stroke-width="${outline}" stroke-linejoin="round"`));
      case "fill":
        return geo(`fill="${col}"`);
      case "line": {
        const w = (s.w ?? 5) * (tier === 0 ? 1.15 : 1);
        return geo(`fill="none" stroke="${p.ink}" stroke-width="${(w + outline * 1.3).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"`) + geo(`fill="none" stroke="${col}" stroke-width="${w.toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"`);
      }
      case "stroke":
        return geo(`fill="none" stroke="${col}" stroke-width="${((s.w ?? 3) * (tier === 0 ? 1.2 : 1)).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"`);
    }
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="${p.tile}"/><circle cx="50" cy="46" r="39" fill="${p.halo}"/>${ICONS[kind].map(draw).join("")}</svg>`;
  const uri = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  cache.set(key, uri);
  return uri;
}
