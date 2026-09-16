import { formatOklch, hexAtAlpha, oklchToHex } from "./oklch";
import {
  SEMANTIC_BRIGHT_OVERRIDES,
  SEMANTIC_DARK,
  semanticTokens,
  type ThemeMode,
  type TokenValue,
  THEME_MODES,
} from "./semantic";

// The one source of truth for the Junto design language. Projections:
//   - Tailwind theme CSS  -> scripts/theme-build.ts (theme.generated.css)
//   - TS runtime mirror   -> src/renderer/lib/theme.ts (re-exports this)
//   - SVG export palette  -> src/shared/svg.ts (imports this)
//   - main-process colors -> src/main (imports this)
// Edit values in primitives.ts / semantic.ts, then run `bun run theme:build`.

export { THEME_MODES, type ThemeMode, type TokenValue };
export { contrastRatio, hexToOklch, oklchToHex, type Oklch } from "./oklch";
export { SEMANTIC_DARK, SEMANTIC_BRIGHT_OVERRIDES, semanticTokens };

export const FONT_MONO =
  '"SF Mono", SFMono-Regular, Menlo, Consolas, monospace';
export const FONT_DISPLAY =
  '"Arial Narrow", "Avenir Next Condensed", "Helvetica Neue", sans-serif';

/** Resolve a token to its solid OKLCH, following aliases. Mixes have no
 *  single solid resolution — use `tokenCss` / `tokenRuntime` instead. */
const resolveSolid = (
  tokens: Record<string, TokenValue>,
  name: string,
): { l: number; c: number; h: number } => {
  let current = tokens[name];
  if (!current) throw new Error(`unknown theme token: ${name}`);
  while (current.kind === "alias") {
    const next = tokens[current.token];
    if (!next) throw new Error(`unknown theme token: ${current.token}`);
    current = next;
  }
  if (current.kind !== "solid")
    throw new Error(`token ${name} is a mix, not a solid`);
  return current.value;
};

/** CSS projection: oklch() for solids, var() for aliases, color-mix() for
 *  mixes. Mixes resolve against the active mode's tokens, so a single
 *  definition serves both modes. */
export const tokenCss = (name: string, value: TokenValue): string => {
  switch (value.kind) {
    case "solid":
      return formatOklch(value.value);
    case "alias":
      return `var(--color-${value.token})`;
    case "mix":
      return `color-mix(in oklab, var(--color-${value.token}) ${value.pct}%, transparent)`;
  }
};

/** Runtime projection (canvas 2D, xterm, Three.js, inline styles): hex for
 *  solids/aliases, rgba() for mixes. */
export const themeRuntime = (mode: ThemeMode): Record<string, string> => {
  const tokens = semanticTokens(mode);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(tokens)) {
    out[name] =
      value.kind === "mix"
        ? hexAtAlpha(
            oklchToHex(resolveSolid(tokens, value.token)),
            value.pct / 100,
          )
        : oklchToHex(resolveSolid(tokens, name));
  }
  return out;
};

/** Convenience: the dark runtime map, for legacy single-mode consumers. */
export const DARK_RUNTIME: Record<string, string> = themeRuntime("dark");

/** Token names in declaration order (dark is the complete set). */
export const TOKEN_NAMES: readonly string[] = Object.keys(SEMANTIC_DARK);

/**
 * The one rule that turns the operator's stored preference into the concrete
 * theme everything paints from.
 *
 * `dark`/`bright` are the operator's explicit choice. `system` means exactly
 * one thing — follow the OS — so the caller supplies that reading (main:
 * Electron nativeTheme; renderer: prefers-color-scheme). Both call THIS
 * function so the two can never drift, the same way `colorFgBgFor` is the one
 * mapping for the spawn hint.
 *
 * Absent/unknown preference resolves the same as `system`.
 */
export const resolveThemeMode = (
  preference: string | undefined,
  systemPrefersDark: boolean,
): ThemeMode => {
  if (preference === "dark" || preference === "bright") return preference;
  return systemPrefersDark ? "dark" : "bright";
};

/**
 * COLORFGBG spawn hint: classic `fg;bg` ANSI indices.
 * Dark (light ink on dark ground) → 15;0. Bright (dark ink on paper) → 0;15.
 * Main-process spawn and renderer share this — do not invent a second mapping.
 */
export const colorFgBgFor = (mode: ThemeMode): string =>
  mode === "bright" ? "0;15" : "15;0";

/**
 * CSI ?997;1n (dark) / ?997;2n (light) — Contour/Kitty colour-scheme DSR.
 * Junto dark ≡ dark scheme; bright ≡ light scheme.
 */
export const schemeDsrFor = (mode: ThemeMode): string =>
  mode === "bright" ? "\x1b[?997;2n" : "\x1b[?997;1n";
