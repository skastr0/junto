// The one path grammar cosmetic packs may use: absolute M, L, H, V, Q, C, Z
// with plain decimal numbers, in the part's local space. Pack strings never
// reach the SVG as text: they are tokenized here, transformed, and emitted as
// numbers the renderer formats itself, so a pack cannot inject markup.

export type PathCommand =
  | { readonly op: "M" | "L"; readonly points: readonly [readonly [number, number]] }
  | { readonly op: "Q"; readonly points: readonly [readonly [number, number], readonly [number, number]] }
  | {
      readonly op: "C";
      readonly points: readonly [readonly [number, number], readonly [number, number], readonly [number, number]];
    }
  | { readonly op: "Z" };

const ARITY: Readonly<Record<string, number>> = { M: 2, L: 2, H: 1, V: 1, Q: 4, C: 6, Z: 0 };
const TOKEN = /([MLHVQCZ])|(-?(?:\d+\.?\d*|\.\d+))|([\s,]+)|(.)/gy;

/** Longest path string a pack may carry. */
export const COSMETIC_PATH_MAX = 1200;
/** Coordinates stay inside a generous local box. */
export const COSMETIC_COORD_MAX = 200;

/**
 * Parse a pack path. Returns undefined for anything outside the grammar:
 * unknown letters, relative commands, wrong arity, a path not starting with
 * M, or a coordinate outside the local box.
 */
export function parseCosmeticPath(d: string): ReadonlyArray<PathCommand> | undefined {
  if (d.length === 0 || d.length > COSMETIC_PATH_MAX) return undefined;
  const tokens: Array<string | number> = [];
  TOKEN.lastIndex = 0;
  for (let match = TOKEN.exec(d); match; match = TOKEN.exec(d)) {
    if (match[4] !== undefined) return undefined;
    if (match[1] !== undefined) tokens.push(match[1]);
    else if (match[2] !== undefined) {
      const value = Number(match[2]);
      if (!Number.isFinite(value) || Math.abs(value) > COSMETIC_COORD_MAX) return undefined;
      tokens.push(value);
    }
    if (TOKEN.lastIndex >= d.length) break;
  }
  const out: PathCommand[] = [];
  let x = 0;
  let y = 0;
  let index = 0;
  while (index < tokens.length) {
    const op = tokens[index];
    if (typeof op !== "string") return undefined;
    const arity = ARITY[op] ?? -1;
    const args = tokens.slice(index + 1, index + 1 + arity);
    if (args.length !== arity || args.some((value) => typeof value !== "number")) return undefined;
    const n = args as number[];
    index += 1 + arity;
    if (out.length === 0 && op !== "M") return undefined;
    switch (op) {
      case "M":
      case "L":
        x = n[0]!;
        y = n[1]!;
        out.push({ op, points: [[x, y]] });
        break;
      case "H":
        x = n[0]!;
        out.push({ op: "L", points: [[x, y]] });
        break;
      case "V":
        y = n[0]!;
        out.push({ op: "L", points: [[x, y]] });
        break;
      case "Q":
        out.push({ op, points: [[n[0]!, n[1]!], [n[2]!, n[3]!]] });
        x = n[2]!;
        y = n[3]!;
        break;
      case "C":
        out.push({ op, points: [[n[0]!, n[1]!], [n[2]!, n[3]!], [n[4]!, n[5]!]] });
        x = n[4]!;
        y = n[5]!;
        break;
      case "Z":
        out.push({ op: "Z" });
        break;
      default:
        return undefined;
    }
  }
  return out.length > 0 ? out : undefined;
}
