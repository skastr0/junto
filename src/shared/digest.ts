import { asNodeId, inPaintOrder, regionMembers, regionName, type Canvas, type Node } from "./model";
import { titleOf as modelTitleOf } from "./model/title";
import type { BoardGlanceTopic, PadGlance } from "./work-model";
import type { ActorRefResolver } from "./attention";
import { buildConnectionIndex } from "./connections";
import type { EntitySource, SnapshotState } from "./entities";
import {
  deriveExecutionGraph,
  type LiveTrustViews,
  type WorkItemsOf,
} from "./execution-graph";
import {
  formatRankedStoppageLine,
  rankStoppageSeeds,
} from "./impact";
import type { OccupancySpectrumName } from "./occupancy";
import { resolveSpec, roleOf, type FactoryRole } from "./physics";
import { isAttentionTaskState } from "./task";
import { deriveRegionRollups } from "./region-rollup";
import { readReviewVerdict, type ReviewVerdict } from "./crew";
import { rulesInForce, taskEpoch } from "./rules";

// Deterministic text projection of spatial kinds, exact Work rows and snapshots.
// Model paint order and fixed source order make repeat reads byte-identical.
// Empty seats are design facts; only current Work waits generate blockers.

// Fixed rendering order for the sources section, independent of fetch order.
const SOURCE_ORDER: ReadonlyArray<EntitySource> = ["hermes"];

// Fixed role count key order for the canvas physics section.
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

const titleOf = (node: Node): string => node.kind === "region" && !node.label?.trim()
  ? `unnamed region (${node.id})` : modelTitleOf(node);

const formatStats = (stats: Record<string, string | number>): string => {
  const parts = Object.keys(stats)
    .sort()
    .map((key) => `${key}=${String(stats[key])}`);
  return parts.length > 0 ? parts.join(" ") : "ok";
};

/** Required actor authority plus optional trust/occupancy views. */
export type DigestLiveViews = LiveTrustViews & {
  /** Exact current Work rows supplied separately from the spatial model. */
  readonly itemsOf: WorkItemsOf;
  readonly artifactCounts?: ReadonlyMap<string, number>;
  readonly padGlances?: ReadonlyMap<string, PadGlance>;
  readonly boardGlances?: ReadonlyMap<string, { readonly topics: ReadonlyArray<BoardGlanceTopic>; readonly unread: number }>;
  readonly sheetSizes?: ReadonlyMap<string, { readonly rows: number; readonly columns: number }>;
  /** Exact resolver compiled from execution references. */
  readonly resolveActorRef: ActorRefResolver;
  /** nodeId → occupancy spectrum. Absent/empty seats surface under design only (I13). */
  readonly occupancy?: ReadonlyMap<string, OccupancySpectrumName>;
};

export const digestCanvas = (
  canvas: Canvas,
  snapshots: SnapshotState,
  live: DigestLiveViews,
): string => {
  const name = canvas.name;
  const nodes = inPaintOrder(canvas);
  const edges = [...canvas.wires.values()];
  const nodeById = canvas.nodes;
  const connectionIndex = buildConnectionIndex(snapshots);
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
    itemsOf,
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
  // stays a pure function of doc + snapshots.
  if (groups.length > 0) {
    const rollupLines = ["region rollups"];
    for (const rollup of deriveRegionRollups({
      canvas,
      itemsOf,
      snapshots,
      canvasName: name,
      resolveActorRef: live.resolveActorRef,
      ...trust,
    })) {
      const buckets = [
        rollup.counts.blocked > 0 ? `${rollup.counts.blocked} blocked` : "",
        rollup.counts.attention > 0 ? `${rollup.counts.attention} attention` : "",
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
      scheduler: 0,
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
      if (node.kind === "agent") {
        const entity = connectionIndex.byKey.get(`hermes:${node.agentKey}`);
        entityLines.push(entity ? `  hermes: ${formatStats(entity.stats)}` : "  hermes: stale");
      }
      // Work rows are supplied separately from spatial kinds.
      if (node.kind === "task") {
        const items = itemsOf(node.id);
        const open = items.filter(
          (item) =>
            item.state !== "completed" &&
            item.state !== "canceled" &&
            item.state !== "failed" &&
            item.state !== "rejected" &&
            item.state !== "archived",
        ).length;
        entityLines.push(`  tasks: ${items.length - open}/${items.length} settled`);
      }
      if (node.kind === "requests") {
        const items = itemsOf(node.id);
        const attention = items.filter((item) => isAttentionTaskState(item.state)).length;
        entityLines.push(`  requests: ${attention}/${items.length} need attention`);
      }
      if (node.kind === "artifacts") {
        const count = live.artifactCounts?.get(node.id);
        if (count !== undefined) entityLines.push(`  artifacts: ${count}`);
      }
      if (node.kind === "pad") {
        const pad = live.padGlances?.get(node.id);
        if (pad) entityLines.push(
          `  pad: revision=${pad?.revision ?? 0} shapes=${pad?.shapeCount ?? 0} unread=${pad?.unreadPinCount ?? 0}`,
        );
      }
      if (node.kind === "board") {
        const board = live.boardGlances?.get(node.id);
        const topics = board?.topics ?? [];
        const recent = topics
          .slice()
          .sort(
            (a, b) =>
              // ISO timestamps sort lexicographically (compareTasksByLatestActivityDesc pattern).
              b.lastActivityAt.localeCompare(a.lastActivityAt) ||
              (a.topicId < b.topicId ? -1 : 1),
          )
          .slice(0, 3);
        if (board) entityLines.push(
          `  board: topics=${topics.length} unread=${board?.unread ?? 0}`,
        );
        for (const topic of recent) {
          entityLines.push(`  topic: ${topic.title.replace(/\s+/g, " ").trim()}`);
        }
      }
      if (node.kind === "sheet") {
        const sheet = live.sheetSizes?.get(node.id);
        if (sheet) entityLines.push(
          `  sheet: ${sheet.rows} rows x ${sheet.columns} columns`,
        );
      }
      if (node.kind === "git") {
        const cwd = node.cwd.trim();
        entityLines.push(`  git: ${cwd || "(no folder)"}`);
      }
    }
    sections.push(entityLines);
  }

  // edges — live phase (derived). A blocking edge always shows its phase and
  // reason; an idle one shows the operator's free-text label when there is one.
  if (edges.length > 0) {
    const edgeLines = ["edges"];
    for (const edge of edges) {
      const phase = graph.phaseByEdgeId.get(edge.id) ?? "relates";
      const detail = graph.detailByEdgeId.get(edge.id);
      let token: string;
      if (phase !== "relates" && detail) {
        token = `${phase}(${detail})`;
      } else if (phase === "relates") {
        token = edge.verb;
      } else {
        token = phase;
      }
      edgeLines.push(`${titleForId(edge.from)} --${token}--> ${titleForId(edge.to)}`);
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
        const suffix = first?.kind === "edge" ? ` - ${first.detail}` : "";
        blockerLines.push(`${titleOf(node)}${suffix}`);
      }
    }
    sections.push(blockerLines);
  }

  // impact — stoppage seeds ranked by blast-radius cone size (S7).
  // seed - stops - leads - clear-action. No occupancy in headless digest
  // (live plane); empty lead seats are not marked unstaffed here.
  const rankedStoppages = rankStoppageSeeds(canvas, graph, itemsOf);
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

  // reviews — the durable verdict chain a task carries plus whether a
  // board/task-provenance requires-review rule arms it. Projection, never
  // judgment: the completion gate stays service-side, so the digest shows
  // the exact binding (epoch + subject hash prefix) each verdict addresses
  // and marks entries stale vs the task's CURRENT projected binding. No
  // timestamps (digest contract); chain order is postedAtMs then id.
  const reviewLines = ["reviews"];
  for (const node of nodes) {
    const items = itemsOf(node.id);
    if (items.length === 0) continue;
    const boardLines: string[] = [];
    for (const task of items) {
      const armed = rulesInForce(canvas, node.id, task).some(
        ({ rule, provenance }) =>
          rule.kind === "requires-review" && provenance.kind !== "region",
      );
      const verdicts = [...(task.verdicts ?? [])]
        .map(readReviewVerdict)
        .filter((v): v is ReviewVerdict => v !== undefined)
        .sort(
          (a: ReviewVerdict, b: ReviewVerdict) =>
            a.postedAtMs - b.postedAtMs ||
            (a.verdictId < b.verdictId ? -1 : a.verdictId > b.verdictId ? 1 : 0),
        );
      const currentHash =
        task.subjectHash !== undefined && task.subjectHash.length > 0
          ? task.subjectHash
          : undefined;
      if (!armed && verdicts.length === 0) continue;
      const epoch = taskEpoch(task);
      const taskTitle =
        task.history[0]?.parts
          .filter((part) => part.kind === "text")
          .map((part) => ("text" in part ? part.text : ""))
          .join(" ")
          .trim() || task.id;
      const head = [
        taskTitle,
        `epoch ${epoch}`,
        `subject ${currentHash !== undefined ? currentHash.slice(0, 12) : "-"}`,
        `author ${task.claimedBy ?? "-"}`,
        armed ? "review required" : "review -",
      ].join(" :: ");
      boardLines.push(head);
      verdicts.forEach((verdict, index) => {
        const markers = [
          verdict.epoch === epoch
            ? verdict.subjectHash === currentHash
              ? "current"
              : "stale refs"
            : "old epoch",
        ];
        boardLines.push(
          `  #${index + 1} ${verdict.kind} ${verdict.reviewerSeatId} -> ${verdict.authorSeatId} epoch ${verdict.epoch} subject ${verdict.subjectHash.slice(0, 12)} (${markers[0]})${verdict.findings.length > 0 ? ` - ${verdict.findings.join("; ")}` : ""}`,
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
