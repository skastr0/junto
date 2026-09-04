/**
 * Pure visits model for the task detail view.
 *
 * A task's `visits` travel with the row, but each visit's interior (claim
 * receipts, check results, defect note) stays on the board row it was
 * recorded at. This builder re-joins them from the live document so the
 * operator sees every board; seats never receive this composition.
 */

import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import type {
  CheckResult,
  Task,
  Visit,
  VisitExit,
} from "@shared/work-model";
import {
  claimIsLive,
  latestCompletedVisits,
  rulesInForce,
  taskDefects,
  taskEpoch,
  waiverIsLive,
  type RuleInForce,
} from "@shared/rules";
import { tasksNodeName } from "@shared/tasks-node-identity";

export type VisitReceipt = {
  readonly ruleId: string;
  readonly kind: "claim" | "waiver";
  readonly body: string;
  readonly refs: ReadonlyArray<string>;
  /** Rule text when the rule is still in force at that board. */
  readonly ruleText?: string;
  readonly provenance?: string;
  /** The same derived liveness used by closure accounting. */
  readonly live: boolean;
};

export type VisitReceiptState = "live" | "superseded" | "mixed";

export type VisitCheck = {
  readonly checkId: string;
  readonly side: CheckResult["side"];
  readonly label: string;
  readonly command: string;
  readonly exitCode: number;
  readonly at: string;
  readonly epoch: number;
  readonly green: boolean;
  readonly outputTail: string;
};

export type VisitOpenRule = {
  readonly ruleId: string;
  readonly text: string;
  readonly provenance: string;
};

export type VisitLayer = {
  readonly key: string;
  /** 1-based position in the visits. */
  readonly ordinal: number;
  readonly boardId: string;
  readonly board: string;
  readonly epoch: number;
  /** Liveness of the evidence currently retained on this completed board row. */
  readonly receiptState?: VisitReceiptState;
  /** This completed visit is shadowed by a later targeted defect. */
  readonly needsRedo: boolean;
  /** The visit the task is living right now. */
  readonly live: boolean;
  readonly enteredAt: string;
  readonly exitedAt?: string;
  readonly exit?: VisitExit;
  readonly next?: string;
  readonly nextBoard?: string;
  readonly claimedBy?: string;
  readonly handoffNote?: string;
  /** Every ref cited by this visit's receipts and defect. */
  readonly refs: ReadonlyArray<string>;
  readonly receipts: ReadonlyArray<VisitReceipt>;
  readonly checks: ReadonlyArray<VisitCheck>;
  readonly openRules: ReadonlyArray<VisitOpenRule>;
  readonly defect?: {
    readonly summary: string;
    readonly refs: ReadonlyArray<string>;
    readonly target: string;
    readonly targetBoard: string;
  };
  /** First layer of its epoch — the view draws an epoch boundary above it. */
  readonly epochStart: boolean;
  /** Defect that opened this layer's epoch. */
  readonly epochDefect?: {
    readonly target: string;
    readonly targetBoard: string;
  };
};

export type TaskVisitsView = {
  readonly layers: ReadonlyArray<VisitLayer>;
  readonly epoch: number;
  readonly boardCount: number;
};

const nodeById = (doc: CanvasDoc, nodeId: string): CanvasNode | undefined =>
  doc.nodes.find((node) => node.id === nodeId);

const rowAt = (doc: CanvasDoc, nodeId: string, taskId: string): Task | undefined =>
  nodeById(doc, nodeId)?.ether?.tasks?.items.find((item) => item.id === taskId);

export const boardLabel = (doc: CanvasDoc, nodeId: string): string =>
  tasksNodeName(nodeById(doc, nodeId), nodeId);

const provenanceText = (rule: RuleInForce): string => {
  switch (rule.provenance.kind) {
    case "region":
      return `region ${rule.provenance.label}`;
    case "board":
      return "this board";
    case "task":
      return "task rule";
  }
};

const cleanRefs = (refs: ReadonlyArray<string> | undefined): ReadonlyArray<string> =>
  (refs ?? []).map((ref) => ref.trim()).filter((ref) => ref.length > 0);

/**
 * The defect filed when a visit exited `sent-back`. The work service writes
 * it as the newest note on the target board's thread; the summary and its
 * refs are parsed back out of that one message.
 */
const defectOf = (
  doc: CanvasDoc,
  task: Task,
  visit: Visit,
  currentNodeId: string,
): {
  readonly summary: string;
  readonly refs: ReadonlyArray<string>;
  readonly target: string;
  readonly targetBoard: string;
} | undefined => {
  if (visit.exit !== "sent-back" || visit.next === undefined) return undefined;
  const row =
    visit.next === currentNodeId ? task : rowAt(doc, visit.next, task.id);
  const marker = `defect from "${visit.board}": `;
  for (let index = (row?.history.length ?? 0) - 1; index >= 0; index -= 1) {
    const text = (row?.history[index]?.parts ?? [])
      .flatMap((part) => (part.kind === "text" ? [part.text] : []))
      .join("\n");
    if (!text.startsWith(marker)) continue;
    const [head, ...rest] = text.slice(marker.length).split("\n");
    return {
      summary: head?.trim() ?? "",
      refs: rest
        .filter((line) => line.startsWith("ref: "))
        .map((line) => line.slice("ref: ".length).trim())
        .filter((ref) => ref.length > 0),
      target: visit.next,
      targetBoard: boardLabel(doc, visit.next),
    };
  }
  return {
    summary: "",
    refs: [],
    target: visit.next,
    targetBoard: boardLabel(doc, visit.next),
  };
};

const receiptsAt = (
  doc: CanvasDoc,
  task: Task,
  visit: Visit,
  row: Task | undefined,
  isLatestCompleted: boolean,
): ReadonlyArray<VisitReceipt> => {
  if (!isLatestCompleted) return [];
  const evidence = row?.completionEvidence;
  const known = new Map(
    rulesInForce(doc, visit.board, task).map((entry) => [entry.rule.id, entry]),
  );
  const decorate = (ruleId: string) => {
    const entry = known.get(ruleId);
    if (entry === undefined) return {};
    return {
      ruleText: entry.rule.text,
      provenance: provenanceText(entry),
    };
  };
  return [
    ...(evidence?.claims ?? []).map((claim) => ({
      ruleId: claim.ruleId,
      kind: "claim" as const,
      body: claim.text,
      refs: cleanRefs(claim.refs),
      live: claimIsLive(task, task.visits ?? [], visit),
      ...decorate(claim.ruleId),
    })),
    ...(evidence?.waivers ?? []).map((waiver) => ({
      ruleId: waiver.ruleId,
      kind: "waiver" as const,
      body: waiver.reason,
      refs: [] as ReadonlyArray<string>,
      live: waiverIsLive(task, visit),
      ...decorate(waiver.ruleId),
    })),
  ];
};

const checksAt = (
  doc: CanvasDoc,
  visit: Visit,
  row: Task | undefined,
): ReadonlyArray<VisitCheck> => {
  const contract = nodeById(doc, visit.board)?.ether?.tasks?.contract;
  const authored = [
    ...(contract?.incoming?.checks ?? []),
    ...(contract?.outgoing?.checks ?? []),
  ];
  return (row?.checkResults ?? [])
    .filter((check) => check.epoch === visit.epoch)
    .map((check) => ({
      checkId: check.checkId,
      side: check.side,
      label: authored.find((entry) => entry.id === check.checkId)?.label ?? check.checkId,
      command: check.command,
      exitCode: check.exitCode,
      at: check.at,
      epoch: check.epoch,
      green: check.exitCode === 0,
      outputTail: check.outputTail,
    }));
};

const openRulesAt = (
  doc: CanvasDoc,
  task: Task,
  visit: Visit,
  receipts: ReadonlyArray<VisitReceipt>,
): ReadonlyArray<VisitOpenRule> => {
  const answered = new Set(receipts.map((receipt) => receipt.ruleId));
  return rulesInForce(doc, visit.board, task)
    .filter((entry) => !answered.has(entry.rule.id))
    .map((entry) => ({
      ruleId: entry.rule.id,
      text: entry.rule.text,
      provenance: provenanceText(entry),
    }));
};

/**
 * Compose the visits for one task. Layers are visit order (oldest first);
 * the live visit is the last entry that has not exited.
 */
export const buildTaskVisits = (
  doc: CanvasDoc,
  task: Task,
  /** Tasks node the open row lives at — its visit reads the live task, not the doc copy. */
  currentNodeId: string,
): TaskVisitsView => {
  const epoch = taskEpoch(task);
  const visits = task.visits ?? [];
  const latestCompleted = latestCompletedVisits(visits);
  const defects = taskDefects(task);
  const layers = visits.map((visit, index) => {
    const row =
      visit.board === currentNodeId ? task : rowAt(doc, visit.board, task.id);
    const isCompleted = visit.exit === "sent-on" || visit.exit === "completed";
    const isLatestCompleted = latestCompleted.get(visit.board) === visit;
    const receipts = receiptsAt(doc, task, visit, row, isLatestCompleted);
    const defect = defectOf(doc, task, visit, currentNodeId);
    const live = visit.exit === undefined && index === visits.length - 1;
    const responseIsLive = isCompleted
      ? claimIsLive(task, visits, visit)
      : true;
    const receiptState = receipts.length === 0
      ? undefined
      : receipts.every((receipt) => receipt.live)
        ? "live" as const
        : receipts.every((receipt) => !receipt.live)
          ? "superseded" as const
          : "mixed" as const;
    const epochStart = index === 0 || visits[index - 1]!.epoch !== visit.epoch;
    const epochDefect = epochStart && visit.epoch > 0
      ? defects.find((entry) => entry.epoch === visit.epoch)
      : undefined;
    return {
      key: `${visit.board}-${visit.epoch}-${visit.enteredAt}-${index}`,
      ordinal: index + 1,
      boardId: visit.board,
      board: boardLabel(doc, visit.board),
      epoch: visit.epoch,
      ...(receiptState !== undefined ? { receiptState } : {}),
      needsRedo: isCompleted && !responseIsLive,
      live,
      enteredAt: visit.enteredAt,
      ...(visit.exitedAt !== undefined ? { exitedAt: visit.exitedAt } : {}),
      ...(visit.exit !== undefined ? { exit: visit.exit } : {}),
      ...(visit.next !== undefined
        ? { next: visit.next, nextBoard: boardLabel(doc, visit.next) }
        : {}),
      ...(visit.claimedBy !== undefined ? { claimedBy: visit.claimedBy } : {}),
      ...(visit.handoffNote !== undefined
        ? { handoffNote: visit.handoffNote }
        : {}),
      refs: [
        ...new Set([
          ...receipts.flatMap((receipt) => receipt.refs),
          ...(defect?.refs ?? []),
        ]),
      ],
      receipts,
      checks: checksAt(doc, visit, row),
      openRules: live ? openRulesAt(doc, task, visit, receipts) : [],
      ...(defect !== undefined ? { defect } : {}),
      epochStart,
      ...(epochDefect !== undefined
        ? {
            epochDefect: {
              target: epochDefect.target,
              targetBoard: boardLabel(doc, epochDefect.target),
            },
          }
        : {}),
    } satisfies VisitLayer;
  });
  return {
    layers,
    epoch,
    boardCount: new Set(layers.map((layer) => layer.boardId)).size,
  };
};

/** Short absolute stamp — visits span days, so the date has to stay. */
export const visitStamp = (iso: string | undefined): string => {
  if (iso === undefined) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

export const layerExitLabel = (layer: VisitLayer): string => {
  if (layer.live) return "Here now";
  switch (layer.exit) {
    case "sent-on":
      return layer.nextBoard ? `Sent on to ${layer.nextBoard}` : "Sent on";
    case "completed":
      return "Completed";
    case "sent-back":
      return layer.nextBoard ? `Sent back to ${layer.nextBoard}` : "Sent back";
    default:
      return "Open";
  }
};
