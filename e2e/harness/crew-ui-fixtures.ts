/**
 * Playwright selectors and canvas seeds for crew mail / review surfaces.
 * Journeys live in p1H; this file is the shared contract those specs import.
 */
import type { CanvasEdge } from "../../src/shared/canvas";
import type { Message, Rule } from "../../src/shared/work-model";
import { verbEdge } from "./sandbox";

export const CREW_UI_SELECTORS = {
  mailRow: "actor-ledger-mail-row",
  mailUnresolved: "actor-ledger-mail-unresolved",
  mailFolded: "actor-ledger-mail-folded",
  edgePortMask: "edge-port-mask",
  edgePortMaskChip: "edge-port-mask-chip",
  requiresReview: "requires-review-authoring",
  verdictChain: "verdict-chain",
  verdictChainEntry: "verdict-chain-entry",
  edgesUnresolved: "actor-edges-unresolved",
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
  allowed: ReadonlyArray<string> | undefined,
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
  readonly queuedAt?: number;
  readonly notifiedAt?: number;
  readonly unresolvedAt?: number;
  readonly refusedAt?: number;
  readonly refusedReason?: string;
  readonly readAt?: number;
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

export const compactReviewVerdict = (input: {
  readonly verdictId: string;
  readonly kind: "green" | "blocking";
  readonly reviewerSeatId: string;
  readonly reviewerLabel?: string;
  readonly taskId: string;
  readonly epoch: number;
  readonly findings?: ReadonlyArray<string>;
}): ReadonlyArray<Record<string, unknown>> => [
  {
    verdictId: input.verdictId,
    kind: input.kind,
    reviewerSeatId: input.reviewerSeatId,
    reviewerLabel: input.reviewerLabel ?? input.reviewerSeatId,
    subject: { kind: "task", taskId: input.taskId, epoch: input.epoch },
    epoch: input.epoch,
    findings: [...(input.findings ?? [])],
    refs: [],
    postedAtMs: 1,
  },
];
