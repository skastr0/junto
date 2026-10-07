import {
  deriveExecutionGraph,
  type ExecutionGraphContext,
} from "./execution-graph";
import { canvasSwatchFor, normalizeHexColor } from "./canvas-colors";
import { inPaintOrder, type Canvas, type Node, type WirePhase } from "./model";
import { titleOf } from "./model/title";
import { themeRuntime, type ThemeMode } from "./theme";
import { hexAtAlpha } from "./theme/oklch";

// Headless render of a canvas to SVG — the "screenshot for agents" half of
// the agent surface (the text half is digest.ts). Pure and deterministic:
// same canvas + actor projection in, same SVG out. No DOM, no Electron.
// Palette comes from the single token source (./theme), projected per mode;
// the default dark projection matches the app's default appearance.

const svgPalette = (mode: ThemeMode) => {
  const t = themeRuntime(mode);
  return {
    ground: t.ground!,
    text: t.ink!,
    dim: t.dim!,
    amber: t.amber!,
    crimson: t.crimson!,
    steel: t.steel!,
    cardFill: t["overlay-1"]!,
    stroke: t.stroke!,
    groupFill: hexAtAlpha(t.steel!, 0.05),
    // The canvas palette (presets and named hex) -> its theme colour.
    swatch: (color: string): string | undefined => {
      const swatch = canvasSwatchFor(color);
      return swatch ? t[swatch.token] : undefined;
    },
    edgeColor: { blocks: t.crimson!, relates: t.steel! } as Record<WirePhase, string>,
  };
};
type SvgPalette = ReturnType<typeof svgPalette>;

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const nodeStroke = (node: Node, pal: SvgPalette): string => {
  if (node.color) {
    const painted = pal.swatch(node.color) ?? normalizeHexColor(node.color);
    if (painted) return painted;
  }
  if (node.kind === "agent") return pal.steel;
  return pal.stroke;
};

/** Furniture says what it is by what is written on it; every other card is headed by its kind. */
const headedByKind = (node: Node): boolean =>
  node.kind !== "note" && node.kind !== "label" && node.kind !== "file" && node.kind !== "link";

const center = (node: Node) => ({ x: node.x + node.width / 2, y: node.y + node.height / 2 });

export const renderCanvasSvg = (
  canvas: Canvas,
  context: ExecutionGraphContext,
  mode: ThemeMode = "dark",
): string => {
  const pal = svgPalette(mode);
  const nodes = inPaintOrder(canvas);
  const graph = deriveExecutionGraph(canvas, context);
  const blocked = graph.blocked;
  const activeEdges = graph.blockedEdgeIds;

  const PAD = 80;
  const xs = nodes.flatMap((n) => [n.x, n.x + n.width]);
  const ys = nodes.flatMap((n) => [n.y, n.y + n.height]);
  const minX = xs.length ? Math.min(...xs) - PAD : 0;
  const minY = ys.length ? Math.min(...ys) - PAD : 0;
  const maxX = xs.length ? Math.max(...xs) + PAD : 800;
  const maxY = ys.length ? Math.max(...ys) + PAD : 600;
  const w = Math.round(maxX - minX);
  const h = Math.round(maxY - minY);

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${Math.round(minX)} ${Math.round(minY)} ${w} ${h}" width="${w}" height="${h}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">`,
  );
  parts.push(`<rect x="${Math.round(minX)}" y="${Math.round(minY)}" width="${w}" height="${h}" fill="${pal.ground}"/>`);

  // Regions behind everything.
  for (const node of nodes) {
    if (node.kind !== "region") continue;
    parts.push(
      `<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="10" fill="${pal.groupFill}" stroke="${pal.stroke}" stroke-width="1"/>`,
    );
    const label = (node.label ?? "").trim();
    if (label) {
      parts.push(
        `<text x="${node.x + 12}" y="${node.y + 20}" fill="${pal.dim}" font-size="12" letter-spacing="1">${esc(label.toUpperCase())}</text>`,
      );
    }
  }

  // Wires.
  for (const edge of canvas.wires.values()) {
    const from = canvas.nodes.get(edge.from);
    const to = canvas.nodes.get(edge.to);
    if (!from || !to) continue;
    const a = center(from);
    const b = center(to);
    const kind = graph.phaseByEdgeId.get(edge.id);
    const agentMsg =
      kind !== "blocks" &&
      from.kind === "agent" &&
      to.kind === "agent" &&
      // The only verb an agent pair can hold, and it opens the mailbox.
      edge.verb === "messages";
    const color = kind === "blocks" ? pal.crimson : agentMsg ? pal.amber : kind ? pal.edgeColor[kind] : pal.steel;
    const active = activeEdges.has(edge.id);
    const strokeW = active ? 2 : agentMsg ? 1.6 : 1;
    const opacity = active ? 0.9 : agentMsg ? 0.88 : 0.5;
    parts.push(
      `<line x1="${Math.round(a.x)}" y1="${Math.round(a.y)}" x2="${Math.round(b.x)}" y2="${Math.round(b.y)}" stroke="${color}" stroke-width="${strokeW}" opacity="${opacity}"${kind === "blocks" ? ' stroke-dasharray="6 4"' : ""}/>`,
    );
    if (kind) {
      parts.push(
        `<text x="${Math.round((a.x + b.x) / 2)}" y="${Math.round((a.y + b.y) / 2)}" fill="${pal.dim}" font-size="10" text-anchor="middle">${esc(kind)}</text>`,
      );
    }
  }

  // Cards.
  for (const node of nodes) {
    if (node.kind === "region") continue;
    const stroke = nodeStroke(node, pal);
    const dim = blocked.has(node.id);
    parts.push(
      `<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="8" fill="${pal.cardFill}" stroke="${stroke}" stroke-width="1" opacity="${dim ? 0.85 : 1}"/>`,
    );
    const kind = headedByKind(node) ? node.kind : undefined;
    if (kind) {
      parts.push(
        `<text x="${node.x + 12}" y="${node.y + 18}" fill="${pal.dim}" font-size="9" letter-spacing="1">${esc(kind.toUpperCase())}</text>`,
      );
    }
    const title = titleOf(node);
    if (title) {
      // Truncate to what fits the node width (~7.5px per char at 14px mono).
      const maxChars = Math.max(4, Math.floor((node.width - 24) / 7.5));
      const clipped = title.length > maxChars ? `${title.slice(0, maxChars - 1)}…` : title;
      parts.push(
        `<text x="${node.x + 12}" y="${node.y + (kind ? 40 : 28)}" fill="${pal.text}" font-size="14">${esc(clipped)}</text>`,
      );
    }
  }

  parts.push("</svg>");
  return parts.join("\n");
};
