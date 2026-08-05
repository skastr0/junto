import type { CanvasDoc, CanvasNode, EtherEdgeKind } from "./canvas";
import {
  deriveExecutionGraph,
  type ExecutionGraphContext,
} from "./execution-graph";
import { isGroup } from "./graph";
import { edgeMaskAllows } from "./physics";
import { DARK_RUNTIME } from "./theme";
import { hexAtAlpha } from "./theme/oklch";

// Headless render of a canvas to SVG — the "screenshot for agents" half of
// the agent surface (the text half is digest.ts). Pure and deterministic:
// same doc + actor projection in, same SVG out. No DOM, no Electron.
// Palette comes from the single token source (./theme) — the dark runtime
// projection, matching the app's default mode.

const GROUND = DARK_RUNTIME.ground!;
const TEXT = DARK_RUNTIME.ink!;
const DIM = DARK_RUNTIME.dim!;
const AMBER = DARK_RUNTIME.amber!;
const CRIMSON = DARK_RUNTIME.crimson!;
const STEEL = DARK_RUNTIME.steel!;
const CARD_FILL = DARK_RUNTIME["overlay-1"]!;
const STROKE = DARK_RUNTIME.stroke!;
const GROUP_FILL = hexAtAlpha(DARK_RUNTIME.steel!, 0.05);

// JSON Canvas preset colors 1..6 -> border tint.
const PRESET: Record<string, string> = {
  "1": CRIMSON,
  "2": DARK_RUNTIME.orange!,
  "3": DARK_RUNTIME.gold!,
  "4": DARK_RUNTIME.green!,
  "5": DARK_RUNTIME.cyan!,
  "6": DARK_RUNTIME.violet!,
};

const EDGE_COLOR: Record<EtherEdgeKind, string> = {
  blocks: CRIMSON,
  relates: STEEL,
};

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const nodeStroke = (node: CanvasNode): string => {
  if (node.ether?.flags?.includes("blocker")) return CRIMSON;
  if (node.color && PRESET[node.color]) return PRESET[node.color]!;
  if (node.ether?.entity?.kind === "agent") return STEEL;
  return STROKE;
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
): string => {
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
  parts.push(`<rect x="${Math.round(minX)}" y="${Math.round(minY)}" width="${w}" height="${h}" fill="${GROUND}"/>`);

  // Groups behind everything.
  for (const node of doc.nodes.filter(isGroup)) {
    parts.push(
      `<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="10" fill="${GROUP_FILL}" stroke="${STROKE}" stroke-width="1"/>`,
    );
    const label = nodeTitle(node);
    if (label) {
      parts.push(
        `<text x="${node.x + 12}" y="${node.y + 20}" fill="${DIM}" font-size="12" letter-spacing="1">${esc(label.toUpperCase())}</text>`,
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
      edgeMaskAllows(edge, "msg.send");
    const color = kind === "blocks" ? CRIMSON : agentMsg ? AMBER : kind ? EDGE_COLOR[kind] : STEEL;
    const active = activeEdges.has(edge.id);
    const strokeW = active ? 2 : agentMsg ? 1.6 : 1;
    const opacity = active ? 0.9 : agentMsg ? 0.88 : 0.5;
    parts.push(
      `<line x1="${Math.round(a.x)}" y1="${Math.round(a.y)}" x2="${Math.round(b.x)}" y2="${Math.round(b.y)}" stroke="${color}" stroke-width="${strokeW}" opacity="${opacity}"${kind === "blocks" ? ' stroke-dasharray="6 4"' : ""}/>`,
    );
    const label = edge.label ?? kind;
    if (label) {
      parts.push(
        `<text x="${Math.round((a.x + b.x) / 2)}" y="${Math.round((a.y + b.y) / 2)}" fill="${DIM}" font-size="10" text-anchor="middle">${esc(label)}</text>`,
      );
    }
  }

  // Nodes.
  for (const node of doc.nodes) {
    if (isGroup(node)) continue;
    const stroke = nodeStroke(node);
    const dim = blocked.has(node.id);
    parts.push(
      `<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="8" fill="${CARD_FILL}" stroke="${stroke}" stroke-width="1" opacity="${dim ? 0.85 : 1}"/>`,
    );
    const kind = node.ether?.entity?.kind;
    if (kind) {
      parts.push(
        `<text x="${node.x + 12}" y="${node.y + 18}" fill="${DIM}" font-size="9" letter-spacing="1">${esc(kind.toUpperCase())}</text>`,
      );
    }
    const title = nodeTitle(node);
    if (title) {
      // Truncate to what fits the node width (~7.5px per char at 14px mono).
      const maxChars = Math.max(4, Math.floor((node.width - 24) / 7.5));
      const clipped = title.length > maxChars ? `${title.slice(0, maxChars - 1)}…` : title;
      parts.push(
        `<text x="${node.x + 12}" y="${node.y + (kind ? 40 : 28)}" fill="${TEXT}" font-size="14">${esc(clipped)}</text>`,
      );
    }
  }

  parts.push("</svg>");
  return parts.join("\n");
};
