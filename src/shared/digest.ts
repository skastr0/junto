import type { CanvasDoc, CanvasNode } from "./canvas";
import type { EntitySource, SnapshotState } from "./entities";
import { findEntity } from "./entities";
import { deriveExecutionGraph, type GlyphView } from "./execution-graph";
import { groupMembers, isGroup } from "./graph";

// Deterministic text projection of a canvas + snapshots for agent consumption.
// Contract: same doc + same snapshots (+ same glyph view) -> byte-identical
// output. No timestamps, no randomness. Sections: regions (with members),
// entities (with stats), edges (live phase), blockers (with closure), seeds
// (unbound entity nodes), sources.
// Ordering is document order throughout; the one place input order is
// unstable (which adapter bundle landed first) is sorted to a fixed source
// order instead.

// Fixed rendering order for the sources section, independent of fetch order.
const SOURCE_ORDER: ReadonlyArray<EntitySource> = ["tower", "quasar", "booth", "hermes"];

const titleOf = (node: CanvasNode): string => {
  switch (node.type) {
    case "text":
      return (node.text.split("\n")[0] ?? "").trim();
    case "file": {
      const base = node.file.split(/[\\/]/).pop();
      return base && base.length > 0 ? base : node.file;
    }
    case "link":
      return node.url;
    case "group":
      return node.label ?? node.id;
  }
};

const formatStats = (stats: Record<string, string | number>): string => {
  const parts = Object.keys(stats)
    .sort()
    .map((key) => `${key}=${String(stats[key])}`);
  return parts.length > 0 ? parts.join(" ") : "ok";
};

const isSeed = (node: CanvasNode): boolean => {
  const kind = node.ether?.entity?.kind;
  // Herdr is a bound work surface (ether.herdr), not an unbound project seed.
  if (kind === "herdr") return false;
  return node.ether?.entity !== undefined && (node.ether.bindings?.length ?? 0) === 0;
};

export const digestCanvas = (
  name: string,
  doc: CanvasDoc,
  snapshots: SnapshotState,
  glyphs?: GlyphView,
): string => {
  const nodeById = new Map(doc.nodes.map((node) => [node.id, node] as const));
  const titleForId = (id: string): string => {
    const node = nodeById.get(id);
    return node ? titleOf(node) : id;
  };

  const graph = deriveExecutionGraph(doc, glyphs ?? new Map());

  const lines: string[] = [
    `canvas :: ${name}`,
    `nodes :: ${doc.nodes.length}`,
    `edges :: ${doc.edges.length}`,
  ];

  const sections: string[][] = [];

  // regions
  const groups = doc.nodes.filter(isGroup);
  if (groups.length > 0) {
    const members = groupMembers(doc);
    const regionLines = ["regions"];
    for (const group of groups) {
      const memberTitles = (members.get(group.id) ?? []).map(titleForId);
      regionLines.push(`${titleOf(group)} :: ${memberTitles.join(", ")}`);
    }
    sections.push(regionLines);
  }

  // entities
  const entityNodes = doc.nodes.filter((node) => node.ether?.entity !== undefined);
  if (entityNodes.length > 0) {
    const entityLines = ["entities"];
    for (const node of entityNodes) {
      const entity = node.ether?.entity;
      if (!entity) continue;
      entityLines.push(`${titleOf(node)} :: ${entity.kind}`);
      for (const binding of node.ether?.bindings ?? []) {
        const bundle = snapshots.bundles.find((b) => b.source === binding.source);
        const found = bundle?.ok
          ? findEntity(snapshots, binding.source, binding.ref.key)
          : undefined;
        entityLines.push(
          found ? `  ${binding.source}: ${formatStats(found.stats)}` : `  ${binding.source}: stale`,
        );
      }
      // Local task checklist lives in the document.
      if (entity.kind === "task") {
        const items = node.ether?.tasks?.items ?? [];
        const open = items.filter((item) => !item.done).length;
        entityLines.push(`  tasks: ${items.length - open}/${items.length} done`);
      }
    }
    sections.push(entityLines);
  }

  // edges — live phase (derived). Free-text labels win only for plain relates
  // without criteria (authorial annotation). Criteria edges always show phase.
  if (doc.edges.length > 0) {
    const edgeLines = ["edges"];
    for (const edge of doc.edges) {
      const phase = graph.phaseByEdgeId.get(edge.id) ?? "relates";
      const detail = graph.detailByEdgeId.get(edge.id);
      let token: string;
      if (edge.ether?.criteria && detail && phase !== "relates") {
        token = `${phase}(${detail})`;
      } else if (phase === "relates" && edge.label && !edge.ether?.kind && !edge.ether?.criteria) {
        token = edge.label;
      } else {
        token = phase;
      }
      edgeLines.push(`${titleForId(edge.fromNode)} --${token}--> ${titleForId(edge.toNode)}`);
    }
    sections.push(edgeLines);
  }

  // blockers: seeds (manual flag) + derived blocked closure
  const blockerNodes = doc.nodes.filter((node) => node.ether?.flags?.includes("blocker"));
  if (blockerNodes.length > 0 || graph.blocked.size > 0) {
    const blockerLines = ["blockers", ...blockerNodes.map(titleOf)];
    blockerLines.push(`blocked closure :: ${graph.blocked.size} nodes`);
    for (const node of doc.nodes) {
      if (graph.blocked.has(node.id)) {
        const reasons = graph.reasonsByNodeId.get(node.id) ?? [];
        const first = reasons[0];
        const suffix =
          first?.kind === "edge"
            ? ` · ${first.detail}`
            : first?.kind === "relay"
              ? ` · relay`
              : first?.kind === "seed"
                ? ` · ${first.detail}`
                : "";
        blockerLines.push(`${titleOf(node)}${suffix}`);
      }
    }
    sections.push(blockerLines);
  }

  // seeds
  const seedNodes = doc.nodes.filter(isSeed);
  if (seedNodes.length > 0) {
    sections.push(["seeds", ...seedNodes.map(titleOf)]);
  }

  // sources
  if (snapshots.bundles.length > 0) {
    const sourceLines = ["sources"];
    for (const source of SOURCE_ORDER) {
      const bundle = snapshots.bundles.find((b) => b.source === source);
      if (!bundle) continue;
      sourceLines.push(
        bundle.ok
          ? `${source} :: ok (${bundle.entities.length} entities)`
          : `${source} :: down (${bundle.error ?? "unknown error"})`,
      );
    }
    sections.push(sourceLines);
  }

  for (const section of sections) {
    lines.push("", ...section);
  }

  return `${lines.join("\n")}\n`;
};
