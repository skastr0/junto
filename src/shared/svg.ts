import type { CanvasDoc, CanvasNode, EtherEdgeKind } from "./canvas";
import {
  deriveExecutionGraph,
  type ExecutionGraphContext,
} from "./execution-graph";
import { isGroup } from "./graph";
import { themeRuntime, type ThemeMode } from "./theme";
import { hexAtAlpha } from "./theme/oklch";

// Headless render of a canvas to SVG — the "screenshot for agents" half of
// the agent surface (the text half is digest.ts). Pure and deterministic:
// same doc + actor projection in, same SVG out. No DOM, no Electron.
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
    // JSON Canvas preset colors 1..6 -> border tint.
    preset: {
      "1": t.crimson!,
      "2": t.orange!,
      "3": t.gold!,
      "4": t.green!,
      "5": t.cyan!,
      "6": t.violet!,
    } as Record<string, string>,
    edgeColor: { blocks: t.crimson!, relates: t.steel! } as Record<
      EtherEdgeKind,
      string
    >,
  };
};
type SvgPalette = ReturnType<typeof svgPalette>;

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const nodeStroke = (node: CanvasNode, pal: SvgPalette): string => {
  if (node.ether?.flags?.includes("blocker")) return pal.crimson;
  if (node.color && pal.preset[node.color]) return pal.preset[node.color]!;
  if (node.ether?.entity?.kind === "agent") return pal.steel;
  return pal.stroke;
};

const nodeTitle = (node: CanvasNode): string => {
  switch (node.type) {
    case "text":
      return (node.text.split("\n")[0] ?? "").trim();
    case "file":
      return node.file.split(/[\\/]/).pop() ?? node.file;
    case "link":
      return node.url;
    case "group":
      return node.label ?? "";
  }
};

const center = (node: CanvasNode) => ({ x: node.x + node.width / 2, y: node.y + node.height / 2 });

export const renderCanvasSvg = (
  doc: CanvasDoc,
  context: ExecutionGraphContext,
  mode: ThemeMode = "dark",
): string => {
  const pal = svgPalette(mode);
  const nodesById = new Map(doc.nodes.map((n) => [n.id, n] as const));
  const graph = deriveExecutionGraph(doc, context);
  const blocked = graph.blocked;
  const activeEdges = graph.blockedEdgeIds;

  const PAD = 80;
  const xs = doc.nodes.flatMap((n) => [n.x, n.x + n.width]);
  const ys = doc.nodes.flatMap((n) => [n.y, n.y + n.height]);
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

  // Groups behind everything.
  for (const node of doc.nodes.filter(isGroup)) {
    parts.push(
      `<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="10" fill="${pal.groupFill}" stroke="${pal.stroke}" stroke-width="1"/>`,
    );
    const label = nodeTitle(node);
    if (label) {
      parts.push(
        `<text x="${node.x + 12}" y="${node.y + 20}" fill="${pal.dim}" font-size="12" letter-spacing="1">${esc(label.toUpperCase())}</text>`,
      );
    }
  }

  // Edges.
  for (const edge of doc.edges) {
    const from = nodesById.get(edge.fromNode);
    const to = nodesById.get(edge.toNode);
    if (!from || !to) continue;
    const a = center(from);
    const b = center(to);
    const kind = graph.phaseByEdgeId.get(edge.id) as EtherEdgeKind | undefined;
    const fromKind = from.ether?.entity?.kind;
    const toKind = to.ether?.entity?.kind;
    const agentMsg =
      kind !== "blocks" &&
      fromKind === "agent" &&
      toKind === "agent" &&
      // The only verb an agent pair can hold, and it opens the mailbox.
      edge.ether?.verb === "messages";
    const color = kind === "blocks" ? pal.crimson : agentMsg ? pal.amber : kind ? pal.edgeColor[kind] : pal.steel;
    const active = activeEdges.has(edge.id);
    const strokeW = active ? 2 : agentMsg ? 1.6 : 1;
    const opacity = active ? 0.9 : agentMsg ? 0.88 : 0.5;
    parts.push(
      `<line x1="${Math.round(a.x)}" y1="${Math.round(a.y)}" x2="${Math.round(b.x)}" y2="${Math.round(b.y)}" stroke="${color}" stroke-width="${strokeW}" opacity="${opacity}"${kind === "blocks" ? ' stroke-dasharray="6 4"' : ""}/>`,
    );
    const label = edge.label ?? kind;
    if (label) {
      parts.push(
        `<text x="${Math.round((a.x + b.x) / 2)}" y="${Math.round((a.y + b.y) / 2)}" fill="${pal.dim}" font-size="10" text-anchor="middle">${esc(label)}</text>`,
      );
    }
  }

  // Nodes.
  for (const node of doc.nodes) {
    if (isGroup(node)) continue;
    const stroke = nodeStroke(node, pal);
    const dim = blocked.has(node.id);
    parts.push(
      `<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="8" fill="${pal.cardFill}" stroke="${stroke}" stroke-width="1" opacity="${dim ? 0.85 : 1}"/>`,
    );
    const kind = node.ether?.entity?.kind;
    if (kind) {
      parts.push(
        `<text x="${node.x + 12}" y="${node.y + 18}" fill="${pal.dim}" font-size="9" letter-spacing="1">${esc(kind.toUpperCase())}</text>`,
      );
    }
    const title = nodeTitle(node);
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
