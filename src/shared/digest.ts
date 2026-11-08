import { asNodeId, inPaintOrder, regionMembers, regionName, type Canvas, type Node } from "./model";
import { titleOf as modelTitleOf } from "./model/title";
import type { ActorRefResolver } from "./attention";
import {
  deriveExecutionGraph,
  type LiveTrustViews,
  type SeatTaskIndex,
  type WorkItemsOf,
} from "./execution-graph";
import {
  formatRankedStoppageLine,
  rankStoppageSeeds,
} from "./impact";
import type { OccupancySpectrumName } from "./occupancy";
import { resolveSpec, roleOf, type FactoryRole } from "./physics";
import { deriveRegionRollups } from "./region-rollup";
import { rulesInForce } from "./rules";
import { isClosedTaskState } from "./task-model";
import { currentApprovals } from "./task-machine";

// Deterministic text projection of spatial kinds and exact Work rows.
// Model paint order makes repeat reads byte-identical.
// Empty seats are design facts; only current Work waits generate blockers.

// Fixed role count key order for the canvas physics section.
const ROLE_ORDER: ReadonlyArray<FactoryRole> = [
  "actor",
  "sink",
  "geography",
];

const ROLE_COUNT_KEY: Record<FactoryRole, string> = {
  actor: "actors",
  sink: "sinks",
  geography: "geography",
};

const titleOf = (node: Node): string => node.kind === "region" && !node.label?.trim()
  ? `unnamed region (${node.id})` : modelTitleOf(node);

/** Required actor authority plus optional trust/occupancy views. */
export type DigestLiveViews = LiveTrustViews & {
  /** The tasks on each task node, from the 0.10 store, supplied apart from the spatial model. */
  readonly itemsOf: WorkItemsOf;
  /** The open task each seat holds: what blocks a seat. */
  readonly heldBy: SeatTaskIndex;
  readonly artifactCounts?: ReadonlyMap<string, number>;
  /** Exact resolver compiled from execution references. */
  readonly resolveActorRef: ActorRefResolver;
  /** nodeId → occupancy spectrum. Absent/empty seats surface under design only (I13). */
  readonly occupancy?: ReadonlyMap<string, OccupancySpectrumName>;
};

export const digestCanvas = (
  canvas: Canvas,
  live: DigestLiveViews,
): string => {
  const name = canvas.name;
  const nodes = inPaintOrder(canvas);
  const edges = [...canvas.wires.values()];
  const nodeById = canvas.nodes;
  const titleForId = (id: string): string => {
    const node = nodeById.get(asNodeId(id));
    return node ? titleOf(node) : id;
  };

  const trust: LiveTrustViews = {
    ...(live.stamps ? { stamps: live.stamps } : {}),
    ...(live.approvals ? { approvals: live.approvals } : {}),
  };
  const itemsOf = live.itemsOf;
  const graph = deriveExecutionGraph(canvas, {
    canvasName: name,
    resolveActorRef: live.resolveActorRef,
    heldBy: live.heldBy,
    ...trust,
  });

  const lines: string[] = [
    `canvas :: ${name}`,
    `nodes :: ${nodes.length}`,
    `edges :: ${edges.length}`,
  ];

  const sections: string[][] = [];

  // regions — nesting-correct as-is: a node inside an inner region is a
  // member of every container, so each ancestor region lists it too.
  const groups = nodes.filter((node) => node.kind === "region");
  if (groups.length > 0) {
    const regionLines = ["regions"];
    for (const group of groups) {
      const memberTitles = regionMembers(canvas, group).map(titleOf);
      regionLines.push(`${regionName(group)} :: ${memberTitles.join(", ")}`);
    }
    sections.push(regionLines);
  }

  // region rollups — severity bubbled up per region (the bottom bar's
  // operational tier). Headless: no agent activity input, so the section
  // stays a pure function of the doc.
  if (groups.length > 0) {
    const rollupLines = ["region rollups"];
    for (const rollup of deriveRegionRollups({
      canvas,
      heldBy: live.heldBy,
      canvasName: name,
      resolveActorRef: live.resolveActorRef,
      ...trust,
    })) {
      const buckets = [
        rollup.counts.attention > 0 ? `${rollup.counts.attention} attention` : "",
        rollup.counts.blocked > 0 ? `${rollup.counts.blocked} blocked` : "",
        rollup.counts.escalated > 0 ? `${rollup.counts.escalated} escalated` : "",
        rollup.counts.working > 0 ? `${rollup.counts.working} working` : "",
      ].filter((part) => part.length > 0);
      const total = `${rollup.counts.total} member${rollup.counts.total === 1 ? "" : "s"}`;
      rollupLines.push(
        buckets.length > 0
          ? `${rollup.label} :: ${rollup.severity} - ${total} (${buckets.join(", ")})`
          : `${rollup.label} :: ${rollup.severity} - ${total}`,
      );
      for (const member of rollup.members) {
        if (member.severity === "idle") continue;
        rollupLines.push(`  ${member.label} :: ${member.severity} - ${member.reasons.join(", ")}`);
      }
    }
    sections.push(rollupLines);
  }

  // canvas physics — derived roles (kind → roleOf/resolveSpec) + cheap
  // held-capability summary (criteria edges vs soft relates). Pure document;
  // no live process-bind / PIDs / occupancy.
  {
    const roleCounts: Record<FactoryRole, number> = {
      actor: 0,
      sink: 0,
      geography: 0,
    };
    for (const node of nodes) {
      const role = roleOf(
        resolveSpec({
          kind: node.kind,
          isGroup: node.kind === "region",
        }),
      );
      roleCounts[role] += 1;
    }
    const roleParts = ROLE_ORDER.map(
      (role) => `${ROLE_COUNT_KEY[role]}=${roleCounts[role]}`,
    );
    sections.push([
      "canvas physics",
      `roles :: ${roleParts.join(" ")}`,
      `edges :: ${edges.length}`,
    ]);
  }

  // design — topology of seats + empty seats (I13: empty never under completion).
  // Headless default: actor seats without occupancy input are empty.
  {
    const designLines = ["design"];
    const seatLines: string[] = [];
    const emptyLines: string[] = [];
    for (const node of nodes) {
      const role = roleOf(
        resolveSpec({
          kind: node.kind,
          isGroup: node.kind === "region",
        }),
      );
      if (role !== "actor") continue;
      const occ = live.occupancy?.get(node.id) ?? "empty";
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
    // Topology summary: edge count only — no soft/stops modes (retired).
    if (edges.length > 0) {
      designLines.push(`topology :: edges=${edges.length}`);
    }
    if (designLines.length > 1) {
      sections.push(designLines);
    }
  }

  // entities
  const entityNodes = nodes;
  if (entityNodes.length > 0) {
    const entityLines = ["entities"];
    for (const node of entityNodes) {
      entityLines.push(`${titleOf(node)} :: ${node.kind}`);
      // Work rows are supplied separately from spatial kinds.
      if (node.kind === "task") {
        const items = itemsOf(node.id);
        const open = items.filter((item) => !isClosedTaskState(item.current.state)).length;
        entityLines.push(`  tasks: ${items.length - open}/${items.length} settled`);
      }
      if (node.kind === "artifacts") {
        const count = live.artifactCounts?.get(node.id);
        if (count !== undefined) entityLines.push(`  artifacts: ${count}`);
      }
      if (node.kind === "git") {
        const cwd = node.cwd.trim();
        entityLines.push(`  git: ${cwd || "(no folder)"}`);
      }
    }
    sections.push(entityLines);
  }

  // edges — each wire says its verb; stoppage lives on seats, not wires.
  if (edges.length > 0) {
    const edgeLines = ["edges"];
    for (const edge of edges) {
      edgeLines.push(`${titleForId(edge.from)} --${edge.verb}--> ${titleForId(edge.to)}`);
    }
    sections.push(edgeLines);
  }

  // blockers: the derived blocked closure
  if (graph.blocked.size > 0) {
    const blockerLines = ["blockers"];
    blockerLines.push(`blocked closure :: ${graph.blocked.size} nodes`);
    for (const node of nodes) {
      if (graph.blocked.has(node.id)) {
        const reasons = graph.reasonsByNodeId.get(node.id) ?? [];
        const first = reasons[0];
        const suffix = first ? ` - ${first.detail}` : "";
        blockerLines.push(`${titleOf(node)}${suffix}`);
      }
    }
    sections.push(blockerLines);
  }

  // impact — stoppage seeds ranked by blast-radius cone size (S7).
  // seed - stops - leads - clear-action. No occupancy in headless digest
  // (live plane); empty lead seats are not marked unstaffed here.
  const rankedStoppages = rankStoppageSeeds(canvas, graph);
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

  // reviews: each task's stamps at the node it sits on, and whether a board
  // requires-review rule arms it there. Projection, never judgment: the
  // ruler decides. Each stamp shows the epoch it binds to and is marked
  // current or old epoch against the task's own. No timestamps (digest
  // contract); stamps keep the order they were given.
  const reviewLines = ["reviews"];
  for (const node of nodes) {
    const items = itemsOf(node.id);
    if (items.length === 0) continue;
    const armed = rulesInForce(canvas, node.id).some(
      ({ rule, provenance }) => rule.kind === "requires-review" && provenance.kind !== "region",
    );
    const boardLines: string[] = [];
    for (const task of items) {
      const { epoch, stamps, stampPolicy, assignee } = task.current;
      if (!armed && stamps.length === 0 && stampPolicy.required === 0) continue;
      boardLines.push([
        task.title,
        `epoch ${epoch}`,
        `assignee ${assignee === undefined ? "-" : titleForId(assignee)}`,
        `stamps ${currentApprovals(task.current)}/${stampPolicy.required}`,
        armed ? "review required" : "review -",
      ].join(" :: "));
      stamps.forEach((stamp, index) => {
        const reviewer = stamp.reviewer.kind === "operator" ? "operator" : titleForId(stamp.reviewer.seat);
        const subject = stamp.subjectHash === undefined ? "" : ` subject ${stamp.subjectHash.slice(0, 12)}`;
        boardLines.push(
          `  #${index + 1} ${stamp.verdict} ${reviewer} epoch ${stamp.epoch}${subject} (${stamp.epoch === epoch ? "current" : "old epoch"})${stamp.text === undefined ? "" : ` - ${stamp.text}`}`,
        );
      });
    }
    if (boardLines.length > 0) {
      reviewLines.push(`${titleOf(node)}`, ...boardLines);
    }
  }
  if (reviewLines.length > 1) {
    sections.push(reviewLines);
  }

  for (const section of sections) {
    lines.push("", ...section);
  }

  return `${lines.join("\n")}\n`;
};
