/**
 * Playwright selectors and canvas seeds for crew mail / review surfaces.
 * Journeys live in p1H; this file is the shared contract those specs import.
 */
import type { CanvasEdge } from "../../src/shared/canvas";
import type { Port } from "../../src/shared/physics/schema";
import type { Message, Rule } from "../../src/shared/work-model";
import { verbEdge } from "./sandbox";

export const CREW_UI_SELECTORS = {
  mailRow: "actor-ledger-mail-row",
  mailFolded: "actor-ledger-mail-folded",
  ledger: "actor-ledger",
  taskDetail: "task-detail",
  requiresReview: "requires-review-authoring",
  verdictChain: "verdict-chain",
  verdictChainEntry: "verdict-chain-entry",
  canvasDigest: "canvas-digest",
  canvasDigestBody: "canvas-digest-body",
} as const;

export const CREW_UI_COMMITS = [
  "20b83424",
  "31315f9b",
  "363b1bcb",
] as const;

/** `ether.mask` is the allow-list. Omitted grants the compile; empty grants none. */
export const messagesEdgeWithMask = (
  id: string,
  fromNode: string,
  toNode: string,
  kinds: Parameters<typeof verbEdge>[4],
  allowed: ReadonlyArray<Port> | undefined,
): CanvasEdge => {
  const edge = verbEdge(id, fromNode, toNode, "messages", kinds);
  return allowed === undefined
    ? edge
    : { ...edge, ether: { verb: "messages", mask: [...allowed] } };
};

export const reviewsEdge = (
  id: string,
  reviewer: string,
  author: string,
  kinds: Parameters<typeof verbEdge>[4],
): CanvasEdge => verbEdge(id, reviewer, author, "reviews", kinds);

export const requiresReviewRule = (id = "rule-requires-review"): Rule => ({
  id,
  text: "A distinct reviewer must record green on the current epoch.",
  kind: "requires-review",
});

export const crewMailMetadata = (input: {
  readonly fromSeat: string;
  readonly senderNodeId?: string;
  readonly senderName?: string;
  readonly mailKind?: "notice" | "prompt" | "receipt";
  readonly subject?: string;
  readonly queuedAt?: string;
  readonly notifiedAt?: string;
  readonly unresolvedAt?: string;
  readonly refusedAt?: string;
  readonly refusedReason?: string;
  readonly generation?: string;
  readonly readAt?: number | string;
  readonly refs?: ReadonlyArray<{ readonly kind: "commit"; readonly sha: string }>;
}): NonNullable<Message["metadata"]> => ({
  fromSeat: input.fromSeat,
  ...(input.senderNodeId === undefined ? {} : { senderNodeId: input.senderNodeId }),
  ...(input.senderName === undefined ? {} : { senderName: input.senderName }),
  ...(input.mailKind === undefined ? {} : { mailKind: input.mailKind }),
  ...(input.subject === undefined ? {} : { subject: input.subject }),
  ...(input.queuedAt === undefined ? {} : { queuedAt: input.queuedAt }),
  ...(input.notifiedAt === undefined ? {} : { notifiedAt: input.notifiedAt }),
  ...(input.unresolvedAt === undefined ? {} : { unresolvedAt: input.unresolvedAt }),
  ...(input.refusedAt === undefined ? {} : { refusedAt: input.refusedAt }),
  ...(input.refusedReason === undefined ? {} : { refusedReason: input.refusedReason }),
  ...(input.generation === undefined ? {} : { generation: input.generation }),
  ...(input.readAt === undefined ? {} : { readAt: input.readAt }),
  ...(input.refs === undefined ? {} : { refs: input.refs }),
});

export const crewMailMessage = (input: {
  readonly messageId: string;
  readonly text: string;
  readonly metadata: NonNullable<Message["metadata"]>;
}): Message => ({
  messageId: input.messageId,
  role: "user",
  parts: [{ kind: "text", text: input.text }],
  metadata: input.metadata,
});

/**
 * Canvas / loadTaskMap stamp: `task.verdicts` + `task.subjectHash`.
 * Never seed metadata.reviewSubject or metadata.verdicts.
 */
export const taskReviewProjection = (input: {
  readonly subjectHash: string;
  readonly verdicts: ReadonlyArray<Record<string, unknown>>;
}): {
  readonly subjectHash: string;
  readonly verdicts: ReadonlyArray<Record<string, unknown>>;
} => ({
  subjectHash: input.subjectHash,
  verdicts: input.verdicts,
});

/** Canonical ReviewVerdict rows for `task.verdicts` (ascending postedAtMs). */
export const compactReviewVerdict = (input: {
  readonly verdictId: string;
  readonly kind: "green" | "blocking";
  readonly reviewerSeatId: string;
  readonly authorSeatId: string;
  readonly taskId: string;
  readonly epoch: number;
  readonly subjectHash: string;
  readonly installationId?: string;
  readonly canvasName?: string;
  readonly nodeId?: string;
  readonly reviewerNodeId?: string;
  readonly findings?: ReadonlyArray<string>;
}): ReadonlyArray<Record<string, unknown>> => [
  {
    verdictId: input.verdictId,
    kind: input.kind,
    reviewerSeatId: input.reviewerSeatId,
    ...(input.reviewerNodeId === undefined
      ? {}
      : { reviewerNodeId: input.reviewerNodeId }),
    authorSeatId: input.authorSeatId,
    subject: {
      kind: "task",
      installationId: input.installationId ?? "local",
      canvasName: input.canvasName ?? "ops",
      nodeId: input.nodeId ?? "tasks",
      taskId: input.taskId,
      epoch: input.epoch,
      subjectHash: input.subjectHash,
    },
    subjectHash: input.subjectHash,
    epoch: input.epoch,
    findings: [...(input.findings ?? [])],
    refs: [],
    postedAtMs: 1,
  },
];
