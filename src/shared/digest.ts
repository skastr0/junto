import { Match } from "effect";
import type { CanvasDoc, CanvasNode, GroupNode } from "./canvas";
import { buildConnectionIndex, resolveConnections, type Connection } from "./connections";
import type { EntitySource, SnapshotState } from "./entities";
import {
  clearingStampsForDoc,
  deriveExecutionGraph,
  type GlyphView,
  type LiveTrustViews,
} from "./execution-graph";
import { groupMembers, isGroup } from "./graph";
import {
  formatRankedStoppageLine,
  rankStoppageSeeds,
} from "./impact";
import type { OccupancySpectrumName } from "./occupancy";
import { resolveSpec, roleOf, type FactoryRole } from "./physics";
import { deriveRegionRollups } from "./region-rollup";

// Deterministic text projection of a canvas + snapshots for agent consumption.
// Contract: same doc + same snapshots (+ same glyph/trust views) -> byte-identical
// output. No timestamps, no randomness. Sections: regions (with members),
// region rollups (severity), factory physics (role counts + soft/criteria
// edges), design (topology + empty seats — I13), completion (stamped /
// cleared proof — never empty seats), entities (with stats), edges (live
// phase), blockers (with closure), seeds (unbound entity nodes), sources.
// Ordering is document order throughout; the one place input order is
// unstable (which adapter bundle landed first) is sorted to a fixed source
// order instead.
//
// Factory physics is headless and pure document: roles via roleOf/resolveSpec
// (never authorial ether.role), capability summary = edge criteria vs soft.
// Occupancy is optional live input for design empty-seat lines only.

// Fixed rendering order for the sources section, independent of fetch order.
const SOURCE_ORDER: ReadonlyArray<EntitySource> = ["hermes"];

// Fixed role count key order for the factory physics section.
const ROLE_ORDER: ReadonlyArray<FactoryRole> = [
  "actor",
  "sink",
  "scheduler",
  "geography",
];

const ROLE_COUNT_KEY: Record<FactoryRole, string> = {
  actor: "actors",
  sink: "sinks",
  scheduler: "schedulers",
  geography: "geography",
};

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

// Region naming follows the rollup convention (trimmed label, human
// fallback) so the regions and region rollups sections name a region the
// same way. titleOf's group branch stays for member/edge contexts.
const regionTitle = (group: GroupNode): string => (group.label ?? "").trim() || "unnamed region";

const formatStats = (stats: Record<string, string | number>): string => {
  const parts = Object.keys(stats)
    .sort()
    .map((key) => `${key}=${String(stats[key])}`);
  return parts.length > 0 ? parts.join(" ") : "ok";
};

// A seed is an entity card whose identity resolves to nothing in the live
// corpus yet — planned, not real. Exhaustive over NodeSpec so the exceptions
// are stated once, per variant, instead of as a negation chain:
//   agent  — hermes connection is identity-declared, never a seed
//   herdr  — PTY bound by construction, never a seed
//   page   — browser surface bound by construction, never a seed
// A raw terminal has no declared identity to resolve, so it can still be a seed.
const seedEligible = (node: CanvasNode): boolean =>
  Match.value(
    resolveSpec({ isGroup: isGroup(node), kind: node.ether?.entity?.kind }),
  ).pipe(
    Match.tagsExhaustive({
      Actor: (spec) => spec.kind === "terminal",
      Sink: (spec) => spec.kind !== "page",
      Scheduler: () => true,
      Geography: () => true,
    }),
  );

const isSeed = (node: CanvasNode, connections: ReadonlyArray<Connection>): boolean =>
  node.ether?.entity !== undefined && seedEligible(node) && connections.length === 0;

/** Optional live inputs for trust plane + seat occupancy (never document truth). */
export type DigestLiveViews = LiveTrustViews & {
  /** nodeId → occupancy spectrum. Absent/empty seats surface under design only (I13). */
  readonly occupancy?: ReadonlyMap<string, OccupancySpectrumName>;
};

export const digestCanvas = (
  name: string,
  doc: CanvasDoc,
  snapshots: SnapshotState,
  glyphs?: GlyphView,
  live?: DigestLiveViews,
): string => {
  const nodeById = new Map(doc.nodes.map((node) => [node.id, node] as const));
  const connectionIndex = buildConnectionIndex(snapshots);
  const titleForId = (id: string): string => {
    const node = nodeById.get(id);
    return node ? titleOf(node) : id;
  };

  const trust: LiveTrustViews = {
    ...(live?.stamps ? { stamps: live.stamps } : {}),
    ...(live?.approvals ? { approvals: live.approvals } : {}),
  };
  const graph = deriveExecutionGraph(doc, glyphs ?? new Map(), trust);

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
      regionLines.push(`${regionTitle(group)} :: ${memberTitles.join(", ")}`);
    }
    sections.push(regionLines);
  }

  // region rollups — severity bubbled up per region (the bottom bar's
  // operational tier). Headless: no agent activity input, so the section
  // stays a pure function of doc + snapshots + glyph view.
  if (groups.length > 0) {
    const rollupLines = ["region rollups"];
    for (const rollup of deriveRegionRollups({ doc, snapshots, glyphs })) {
      const buckets = [
        rollup.counts.blocked > 0 ? `${rollup.counts.blocked} blocked` : "",
        rollup.counts.attention > 0 ? `${rollup.counts.attention} attention` : "",
        rollup.counts.working > 0 ? `${rollup.counts.working} working` : "",
      ].filter((part) => part.length > 0);
      const total = `${rollup.counts.total} member${rollup.counts.total === 1 ? "" : "s"}`;
      rollupLines.push(
        buckets.length > 0
          ? `${rollup.label} :: ${rollup.severity} · ${total} (${buckets.join(", ")})`
          : `${rollup.label} :: ${rollup.severity} · ${total}`,
      );
      for (const member of rollup.members) {
        if (member.severity === "idle") continue;
        rollupLines.push(`  ${member.label} :: ${member.severity} · ${member.reasons.join(", ")}`);
      }
    }
    sections.push(rollupLines);
  }

  // factory physics — derived roles (kind → roleOf/resolveSpec) + cheap
  // held-capability summary (criteria edges vs soft relates). Pure document;
  // no live process-bind / PIDs / occupancy.
  {
    const roleCounts: Record<FactoryRole, number> = {
      actor: 0,
      sink: 0,
      scheduler: 0,
      geography: 0,
    };
    for (const node of doc.nodes) {
      const role = roleOf(
        resolveSpec({
          kind: node.ether?.entity?.kind,
          isGroup: isGroup(node),
        }),
      );
      roleCounts[role] += 1;
    }
    let criteriaEdges = 0;
    let softEdges = 0;
    for (const edge of doc.edges) {
      if (edge.ether?.criteria) criteriaEdges += 1;
      else softEdges += 1;
    }
    const roleParts = ROLE_ORDER.map(
      (role) => `${ROLE_COUNT_KEY[role]}=${roleCounts[role]}`,
    );
    sections.push([
      "factory physics",
      `roles :: ${roleParts.join(" ")}`,
      `capabilities :: criteria=${criteriaEdges} soft=${softEdges}`,
    ]);
  }

  // design — topology of seats + empty seats (I13: empty never under completion).
  // Headless default: actor seats without occupancy input are empty.
  {
    const designLines = ["design"];
    const seatLines: string[] = [];
    const emptyLines: string[] = [];
    for (const node of doc.nodes) {
      const role = roleOf(
        resolveSpec({
          kind: node.ether?.entity?.kind,
          isGroup: isGroup(node),
        }),
      );
      if (role !== "actor") continue;
      const occ = live?.occupancy?.get(node.id) ?? "empty";
      seatLines.push(`${titleOf(node)} :: ${occ}`);
      if (occ === "empty" || occ === "gone") {
        emptyLines.push(`${titleOf(node)} :: ${occ}`);
      }
    }
    if (seatLines.length > 0) {
      designLines.push("seats");
      designLines.push(...seatLines.map((line) => `  ${line}`));
    }
    if (emptyLines.length > 0) {
      designLines.push("empty seats");
      designLines.push(...emptyLines.map((line) => `  ${line}`));
    }
    // Topology summary: criteria modes present (document shape, not completion).
    const modeCounts: Record<string, number> = {};
    for (const edge of doc.edges) {
      const mode = edge.ether?.criteria?.mode ?? "soft";
      modeCounts[mode] = (modeCounts[mode] ?? 0) + 1;
    }
    const modeParts = Object.keys(modeCounts)
      .sort()
      .map((mode) => `${mode}=${modeCounts[mode]}`);
    if (modeParts.length > 0) {
      designLines.push(`topology :: ${modeParts.join(" ")}`);
    }
    if (designLines.length > 1) {
      sections.push(designLines);
    }
  }

  // completion — stamped proofs and cleared phase only. Never lists empty seats (I13).
  {
    const completionLines = ["completion"];
    const cleared = clearingStampsForDoc(doc, live?.stamps);
    if (cleared.length > 0) {
      completionLines.push("stamps");
      for (const { edgeId, stamp } of cleared) {
        const refs = stamp.evidenceRefs.join(",") || "(none)";
        completionLines.push(
          `  ${stamp.step} · seat=${stamp.seat} · edge=${edgeId} · refs=${refs}`,
        );
      }
      completionLines.push("cleared");
      for (const { edgeId, stamp } of cleared) {
        completionLines.push(`  proof edge ${edgeId} · step=${stamp.step}`);
      }
    }
    // Human approvals that clear approval edges.
    if (live?.approvals && live.approvals.size > 0) {
      const approvalClears: string[] = [];
      for (const edge of doc.edges) {
        const criteria = edge.ether?.criteria;
        if (!criteria || criteria.mode !== "approval") continue;
        const grant = live.approvals.get(criteria.step);
        if (grant && grant.principal === "human") {
          approvalClears.push(`  approval edge ${edge.id} · step=${criteria.step}`);
        }
      }
      if (approvalClears.length > 0) {
        if (!completionLines.includes("cleared")) completionLines.push("cleared");
        completionLines.push(...approvalClears);
      }
    }
    if (completionLines.length > 1) {
      sections.push(completionLines);
    }
  }

  // entities
  const entityNodes = doc.nodes.filter((node) => node.ether?.entity !== undefined);
  if (entityNodes.length > 0) {
    const entityLines = ["entities"];
    for (const node of entityNodes) {
      const entity = node.ether?.entity;
      if (!entity) continue;
      entityLines.push(`${titleOf(node)} :: ${entity.kind}`);
      for (const connection of resolveConnections(entity, connectionIndex)) {
        entityLines.push(
          connection.entity
            ? `  ${connection.source}: ${formatStats(connection.entity.stats)}`
            : `  ${connection.source}: stale`,
        );
      }
      // Local work stores live in the document.
      if (entity.kind === "task") {
        const items = node.ether?.tasks?.items ?? [];
        const open = items.filter(
          (item) =>
            item.state !== "completed" &&
            item.state !== "canceled" &&
            item.state !== "failed" &&
            item.state !== "rejected",
        ).length;
        entityLines.push(`  tasks: ${items.length - open}/${items.length} settled`);
      }
      if (entity.kind === "requests") {
        const items = node.ether?.requests?.items ?? [];
        const pending = items.filter((item) => item.state === "input-required").length;
        entityLines.push(`  requests: ${pending}/${items.length} pending`);
      }
      if (entity.kind === "artifacts") {
        const items = node.ether?.artifacts?.items ?? [];
        entityLines.push(`  artifacts: ${items.length}`);
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
            : first?.kind === "seed"
              ? ` · ${first.detail}`
              : "";
        blockerLines.push(`${titleOf(node)}${suffix}`);
      }
    }
    sections.push(blockerLines);
  }

  // impact — stoppage seeds ranked by blast-radius cone size (S7).
  // seed · stops · leads · clear-action. No occupancy in headless digest
  // (live plane); empty lead seats are not marked unstaffed here.
  const rankedStoppages = rankStoppageSeeds(doc, graph);
  if (rankedStoppages.length > 0) {
    const impactLines = ["impact"];
    for (const ranked of rankedStoppages) {
      const line = formatRankedStoppageLine(ranked, { titleOf: titleForId });
      impactLines.push(line);
      impactLines.push(`  seed: ${titleForId(ranked.seedNodeId)}`);
      impactLines.push(`  ${ranked.clearAction}`);
    }
    sections.push(impactLines);
  }

  // seeds
  const seedNodes = doc.nodes.filter((node) =>
    isSeed(node, resolveConnections(node.ether?.entity, connectionIndex)),
  );
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
