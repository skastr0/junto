/**
 * Pure onion model for the task detail journey view.
 *
 * A task's `journey` travels with the row, but each passage's interior
 * (claim receipts, boarding tickets, defect note) stays on the station row it
 * was recorded at. This builder re-joins them from the live document so the
 * operator sees every layer; seats never receive this composition.
 */

import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import type {
  ClaimSeverity,
  Passage,
  PassageExit,
  Task,
  Ticket,
} from "@shared/work-model";
import {
  effectiveClaimsStack,
  latestCompletedPassages,
  receiptLive,
  taskDefects,
  taskEpoch,
  waiverLive,
  type ClaimProvenance,
} from "@shared/claims";
import { nodeTitle } from "../../lib/presentation";

export type JourneyReceipt = {
  readonly claimId: string;
  readonly kind: "response" | "waiver";
  /** Response text or waiver reason. */
  readonly body: string;
  readonly refs: ReadonlyArray<string>;
  /** Claim text when the claim is still authored at that station. */
  readonly claimText?: string;
  readonly severity?: ClaimSeverity;
  readonly provenance?: string;
  /** The same derived liveness used by closure accounting. */
  readonly live: boolean;
};

export type JourneyReceiptState = "live" | "superseded" | "mixed";

export type JourneyTicket = {
  readonly checkId: string;
  readonly side: Ticket["side"];
  readonly label: string;
  readonly command: string;
  readonly exitCode: number;
  readonly at: string;
  readonly epoch: number;
  readonly green: boolean;
  readonly outputTail: string;
};

export type JourneyOpenClaim = {
  readonly claimId: string;
  readonly text: string;
  readonly severity: ClaimSeverity;
  readonly provenance: string;
};

export type JourneyLayer = {
  readonly key: string;
  /** 1-based position in the journey. */
  readonly ordinal: number;
  readonly nodeId: string;
  readonly station: string;
  readonly epoch: number;
  /** Liveness of the evidence currently retained on this completed station row. */
  readonly receiptState?: JourneyReceiptState;
  /** This completed stop is shadowed by a later targeted defect. */
  readonly needsRedo: boolean;
  /** The passage the task is living right now. */
  readonly live: boolean;
  readonly enteredAt: string;
  readonly exitedAt?: string;
  readonly exit?: PassageExit;
  readonly next?: string;
  readonly nextStation?: string;
  readonly claimedBy?: string;
  readonly emissionNote?: string;
  /** Every ref cited by this passage's receipts and defect. */
  readonly refs: ReadonlyArray<string>;
  readonly receipts: ReadonlyArray<JourneyReceipt>;
  readonly tickets: ReadonlyArray<JourneyTicket>;
  readonly openClaims: ReadonlyArray<JourneyOpenClaim>;
  readonly defect?: {
    readonly summary: string;
    readonly refs: ReadonlyArray<string>;
    readonly target: string;
    readonly targetStation: string;
  };
  /** First layer of its epoch — the view draws an epoch boundary above it. */
  readonly epochStart: boolean;
  /** Defect that opened this layer's epoch. */
  readonly epochDefect?: {
    readonly target: string;
    readonly targetStation: string;
  };
};

export type TaskJourneyView = {
  readonly layers: ReadonlyArray<JourneyLayer>;
  readonly epoch: number;
  readonly stationCount: number;
};

const nodeById = (doc: CanvasDoc, nodeId: string): CanvasNode | undefined =>
  doc.nodes.find((node) => node.id === nodeId);

const rowAt = (doc: CanvasDoc, nodeId: string, taskId: string): Task | undefined =>
  nodeById(doc, nodeId)?.ether?.tasks?.items.find((item) => item.id === taskId);

export const stationLabel = (doc: CanvasDoc, nodeId: string): string => {
  const node = nodeById(doc, nodeId);
  if (node === undefined) return nodeId;
  return node.ether?.entity?.name?.trim() || nodeTitle(node);
};

const provenanceText = (provenance: ClaimProvenance, doc: CanvasDoc): string => {
  switch (provenance.kind) {
    case "region":
      return `region ${provenance.label}`;
    case "sink":
      return `station ${stationLabel(doc, provenance.nodeId)}`;
    case "task":
      return "task claim";
  }
};

const cleanRefs = (refs: ReadonlyArray<string> | undefined): ReadonlyArray<string> =>
  (refs ?? []).map((ref) => ref.trim()).filter((ref) => ref.length > 0);

/**
 * The defect filed when a passage exited `rejected-back`. The work service
 * writes it as the newest note on the destination row's thread; the summary
 * and its refs are parsed back out of that one message.
 */
const defectOf = (
  doc: CanvasDoc,
  task: Task,
  passage: Passage,
  currentNodeId: string,
): {
  readonly summary: string;
  readonly refs: ReadonlyArray<string>;
  readonly target: string;
  readonly targetStation: string;
} | undefined => {
  if (passage.exit !== "rejected-back" || passage.next === undefined) return undefined;
  const row =
    passage.next === currentNodeId ? task : rowAt(doc, passage.next, task.id);
  const marker = `defect from "${passage.nodeId}": `;
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
      target: passage.next,
      targetStation: stationLabel(doc, passage.next),
    };
  }
  return {
    summary: "",
    refs: [],
    target: passage.next,
    targetStation: stationLabel(doc, passage.next),
  };
};

const receiptsAt = (
  doc: CanvasDoc,
  task: Task,
  passage: Passage,
  row: Task | undefined,
  isLatestCompleted: boolean,
): ReadonlyArray<JourneyReceipt> => {
  if (!isLatestCompleted) return [];
  const evidence = row?.completionEvidence;
  const known = new Map(
    effectiveClaimsStack(doc, passage.nodeId, task).map((entry) => [
      entry.claim.id,
      entry,
    ]),
  );
  const decorate = (claimId: string) => {
    const entry = known.get(claimId);
    if (entry === undefined) return {};
    return {
      claimText: entry.claim.text,
      severity: entry.claim.severity,
      provenance: provenanceText(entry.provenance, doc),
    };
  };
  return [
    ...(evidence?.responses ?? []).map((response) => ({
      claimId: response.claimId,
      kind: "response" as const,
      body: response.response,
      refs: cleanRefs(response.refs),
      live: receiptLive(task, task.journey ?? [], passage),
      ...decorate(response.claimId),
    })),
    ...(evidence?.claimWaivers ?? []).map((waiver) => ({
      claimId: waiver.claimId,
      kind: "waiver" as const,
      body: waiver.reason,
      refs: [] as ReadonlyArray<string>,
      live: waiverLive(task, passage),
      ...decorate(waiver.claimId),
    })),
  ];
};

const ticketsAt = (
  passage: Passage,
  row: Task | undefined,
): ReadonlyArray<JourneyTicket> =>
  (row?.boarding ?? [])
    .filter((ticket) => ticket.epoch === passage.epoch)
    .map((ticket) => ({
      checkId: ticket.checkId,
      side: ticket.side,
      label: ticket.label,
      command: ticket.command,
      exitCode: ticket.exitCode,
      at: ticket.at,
      epoch: ticket.epoch,
      green: ticket.exitCode === 0,
      outputTail: ticket.outputTail,
    }));

const openClaimsAt = (
  doc: CanvasDoc,
  task: Task,
  passage: Passage,
  receipts: ReadonlyArray<JourneyReceipt>,
): ReadonlyArray<JourneyOpenClaim> => {
  const answered = new Set(receipts.map((receipt) => receipt.claimId));
  return effectiveClaimsStack(doc, passage.nodeId, task)
    .filter((entry) => !answered.has(entry.claim.id))
    .map((entry) => ({
      claimId: entry.claim.id,
      text: entry.claim.text,
      severity: entry.claim.severity,
      provenance: provenanceText(entry.provenance, doc),
    }));
};

/**
 * Compose the onion for one task. Layers are journey order (oldest first);
 * the live passage is the last entry that has not exited.
 */
export const buildTaskJourney = (
  doc: CanvasDoc,
  task: Task,
  /** Sink node the open row lives at — its passage reads the live task, not the doc copy. */
  currentNodeId: string,
): TaskJourneyView => {
  const epoch = taskEpoch(task);
  const passages = task.journey ?? [];
  const latestCompleted = latestCompletedPassages(passages);
  const defects = taskDefects(task);
  const layers = passages.map((passage, index) => {
    const row =
      passage.nodeId === currentNodeId ? task : rowAt(doc, passage.nodeId, task.id);
    const isCompleted = passage.exit === "forwarded" || passage.exit === "closed";
    const isLatestCompleted = latestCompleted.get(passage.nodeId) === passage;
    const receipts = receiptsAt(doc, task, passage, row, isLatestCompleted);
    const defect = defectOf(doc, task, passage, currentNodeId);
    const live = passage.exit === undefined && index === passages.length - 1;
    const responseIsLive = isCompleted
      ? receiptLive(task, passages, passage)
      : true;
    const receiptState = receipts.length === 0
      ? undefined
      : receipts.every((receipt) => receipt.live)
        ? "live" as const
        : receipts.every((receipt) => !receipt.live)
          ? "superseded" as const
          : "mixed" as const;
    const epochStart = index === 0 || passages[index - 1]!.epoch !== passage.epoch;
    const epochDefect = epochStart && passage.epoch > 0
      ? defects.find((entry) => entry.epoch === passage.epoch)
      : undefined;
    return {
      key: `${passage.nodeId}-${passage.epoch}-${passage.enteredAt}-${index}`,
      ordinal: index + 1,
      nodeId: passage.nodeId,
      station: stationLabel(doc, passage.nodeId),
      epoch: passage.epoch,
      ...(receiptState !== undefined ? { receiptState } : {}),
      needsRedo: isCompleted && !responseIsLive,
      live,
      enteredAt: passage.enteredAt,
      ...(passage.exitedAt !== undefined ? { exitedAt: passage.exitedAt } : {}),
      ...(passage.exit !== undefined ? { exit: passage.exit } : {}),
      ...(passage.next !== undefined
        ? { next: passage.next, nextStation: stationLabel(doc, passage.next) }
        : {}),
      ...(passage.claimedBy !== undefined ? { claimedBy: passage.claimedBy } : {}),
      ...(passage.emissionNote !== undefined
        ? { emissionNote: passage.emissionNote }
        : {}),
      refs: [
        ...new Set([
          ...receipts.flatMap((receipt) => receipt.refs),
          ...(defect?.refs ?? []),
        ]),
      ],
      receipts,
      tickets: ticketsAt(passage, row),
      openClaims: live ? openClaimsAt(doc, task, passage, receipts) : [],
      ...(defect !== undefined ? { defect } : {}),
      epochStart,
      ...(epochDefect !== undefined
        ? {
            epochDefect: {
              target: epochDefect.target,
              targetStation: stationLabel(doc, epochDefect.target),
            },
          }
        : {}),
    } satisfies JourneyLayer;
  });
  return {
    layers,
    epoch,
    stationCount: new Set(layers.map((layer) => layer.nodeId)).size,
  };
};

/** Short absolute stamp — journeys span days, so the date has to stay. */
export const journeyStamp = (iso: string | undefined): string => {
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

export const layerExitLabel = (layer: JourneyLayer): string => {
  if (layer.live) return "Here now";
  switch (layer.exit) {
    case "forwarded":
      return layer.nextStation ? `Forwarded to ${layer.nextStation}` : "Forwarded";
    case "closed":
      return "Closed";
    case "rejected-back":
      return layer.nextStation ? `Sent back to ${layer.nextStation}` : "Sent back";
    default:
      return "Open";
  }
};
