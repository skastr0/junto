/**
 * The far-tier and marker glyphs as atlas art (contract SpriteRef
 * `{ atlas: "glyph" }`). Paint names a glyph the way the DOM names its
 * icon — lucide component names for stub kinds and bubble actions, state
 * names for task marks, `kind:`/`kind-glyph:` for the kind seats' far
 * boxes — and this table resolves each name to the same mark the DOM
 * draws, on the same 24x24 lucide grid where there is one.
 *
 * Cells are ink coverage: the rasterizer strokes the nodes in the style's
 * resolved ink at its alpha, so `tok("ink", 0.38)` arrives pre-mixed.
 */

import { GLYPH_NODES, type GlyphNode } from "./glyph-nodes";

/** The glyph names paint emits, resolved to a lucide module name. */
const BY_NAME: Readonly<Record<string, string>> = {
  // PreambleBubbleView's KIND (feed/scene.ts BUBBLE_GLYPH).
  "package-check": "package-check",
  flag: "flag",
  "circle-check": "circle-check",
  activity: "activity",
  mail: "mail",
  send: "send",
  "mail-warning": "mail-warning",
  "circle-dot": "circle-dot",
  // RemoteNodeCards' STUB_LOOK (feed/kinds.ts).
  FileText: "file-text",
  Link2: "link-2",
  GitBranch: "git-branch",
  Globe: "globe",
  FolderTree: "folder-tree",
  // Seat and region marks.
  plus: "plus",
  lock: "lock",
  "alert-triangle": "triangle-alert",
  peer: "user",
  // TaskStateMark's GLYPH, by task state; "working" is the lamp, drawn as
  // the same quiet dot the mark's resting pose reads as.
  "task-state:backlog": "circle-dashed",
  "task-state:assigned": "circle",
  "task-state:working": "circle-dot",
  "task-state:input-required": "circle-pause",
  "task-state:in-review": "stamp",
  "task-state:done": "circle-check",
  "task-state:canceled": "circle-slash",
  "task-state:archived": "archive",
};

/** The kind seats' far box and the default card's far glyph: the kind's
 *  own mark, the same icon the kind seat wears near and mid. */
const BY_KIND: Readonly<Record<string, string>> = {
  task: "clipboard-check",
  artifacts: "layers",
  automations: "cog",
  files: "folder-tree",
  page: "globe",
  terminal: "square-terminal",
  git: "git-branch",
  file: "file-text",
  link: "link-2",
  note: "notebook-pen",
};

const resolveName = (name: string): { readonly nodes: ReadonlyArray<GlyphNode> } | { readonly crown: true } | undefined => {
  if (name === "overseer-crest") return { crown: true };
  if (name.startsWith("kind-glyph:")) {
    const icon = BY_KIND[name.slice("kind-glyph:".length)];
    return icon === undefined ? undefined : { nodes: GLYPH_NODES[icon] ?? [] };
  }
  if (name.startsWith("kind:")) {
    const icon = BY_KIND[name.slice("kind:".length)];
    return icon === undefined ? undefined : { nodes: GLYPH_NODES[icon] ?? [] };
  }
  const icon = BY_NAME[name];
  return icon === undefined ? undefined : { nodes: GLYPH_NODES[icon] ?? [] };
};

/** Whether the name draws anything at all; "preamble" is the bubble's
 *  plain-voice case, which the DOM renders with no glyph element. */
export const glyphKnown = (name: string): boolean => {
  const resolved = resolveName(name);
  return resolved !== undefined && ("crown" in resolved || resolved.nodes.length > 0);
};

const CROWN = "M2 9.5V3.2l3.3 2.6L8 1.2l2.7 4.6L14 3.2v6.3Z";
const CROWN_VIEW = { w: 16, h: 11 } as const;

const num = (value: string | undefined): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const pointsOf = (value: string | undefined): ReadonlyArray<readonly [number, number]> =>
  (value ?? "")
    .trim()
    .split(/[\s,]+/)
    .reduce<ReadonlyArray<readonly [number, number]>>((acc, pair, i, all) => {
      if (i % 2 === 1) return acc;
      const x = Number(all[i]);
      const y = Number(all[i + 1]);
      return Number.isFinite(x) && Number.isFinite(y) ? [...acc, [x, y] as const] : acc;
    }, []);

/** Append one lucide node's geometry to a Path2D on the 24x24 grid. */
const appendNode = (path: Path2D, tag: string, a: Readonly<Record<string, string>>): void => {
  switch (tag) {
    case "path":
      if (a.d !== undefined) path.addPath(new Path2D(a.d));
      return;
    case "circle": {
      const cx = num(a.cx);
      const cy = num(a.cy);
      const r = num(a.r);
      path.moveTo(cx + r, cy);
      path.arc(cx, cy, r, 0, Math.PI * 2);
      return;
    }
    case "ellipse": {
      const cx = num(a.cx);
      const cy = num(a.cy);
      const rx = num(a.rx);
      const ry = num(a.ry);
      path.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      return;
    }
    case "rect": {
      const x = num(a.x);
      const y = num(a.y);
      const w = num(a.width);
      const h = num(a.height);
      const rx = num(a.rx);
      if (rx > 0) path.roundRect(x, y, w, h, rx);
      else path.rect(x, y, w, h);
      return;
    }
    case "line":
      path.moveTo(num(a.x1), num(a.y1));
      path.lineTo(num(a.x2), num(a.y2));
      return;
    case "polyline":
    case "polygon": {
      const pts = pointsOf(a.points);
      if (pts.length === 0) return;
      path.moveTo(pts[0]![0], pts[0]![1]);
      for (const [x, y] of pts.slice(1)) path.lineTo(x, y);
      if (tag === "polygon") path.closePath();
      return;
    }
    default:
      return;
  }
};

/**
 * Draw a glyph into a canvas `size` px square (already at raster scale).
 * `ink` is the resolved style ink: rgb 0-1 and alpha. Returns false when the
 * name resolves to nothing the DOM would draw.
 */
export const drawGlyph = (
  ctx: CanvasRenderingContext2D,
  name: string,
  size: number,
  ink: { readonly r: number; readonly g: number; readonly b: number; readonly a: number },
): boolean => {
  const resolved = resolveName(name);
  if (resolved === undefined) return false;
  const px = Math.max(1, size);
  const css = `rgb(${Math.round(ink.r * 255)} ${Math.round(ink.g * 255)} ${Math.round(ink.b * 255)} / ${ink.a})`;
  ctx.save();
  ctx.scale(px / 24, px / 24);
  if ("crown" in resolved) {
    // The overseer crest keeps its own 16x11 aspect, centred in the cell.
    ctx.restore();
    const k = Math.min(px / CROWN_VIEW.w, px / CROWN_VIEW.h);
    const ox = (px - CROWN_VIEW.w * k) / 2;
    const oy = (px - CROWN_VIEW.h * k) / 2;
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(k, k);
    ctx.fillStyle = css;
    ctx.fill(new Path2D(CROWN));
    ctx.restore();
    return true;
  }
  ctx.strokeStyle = css;
  ctx.fillStyle = css;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const [tag, attrs] of resolved.nodes) {
    const path = new Path2D();
    appendNode(path, tag, attrs);
    const filled = attrs.fill !== undefined && attrs.fill !== "none";
    if (filled) ctx.fill(path);
    else ctx.stroke(path);
  }
  ctx.restore();
  return true;
};
