/**
 * A mention link in a message, drawn as a chip that opens what it names
 * (plan 0.10, 03 section 3: "Rendering is the same everywhere: a chip that
 * opens the seat or resource"). The link's label is what the writer saw; the
 * canvas says what kind the node is now. A node that is gone, or no longer
 * the kind its link names, is drawn unavailable and does not open.
 */
import { matchMention, mentionLinksOf, mentionRefOf, type MentionLinkAt, type MentionRef } from "@shared/mention";
import type { NodeKind } from "@shared/model/kinds";
import type { NodeId } from "@shared/physics/schema";
import { activateNodeSurface } from "./activate-node-surface";
import type { ResourceKind } from "./resource-visuals";
import { openWorkDetail } from "./work-detail-open";

/** What a `ResourceChip` needs to draw one mention. */
export type MentionChip = {
  readonly kind: ResourceKind;
  /** Without the `@` or `#` the link's label carries: the chip adds what its kind needs. */
  readonly label: string;
  readonly number?: number;
  /** Undefined when the node is gone: the chip is drawn unavailable. */
  readonly ref?: MentionRef;
};

const NUMBERED = /^#(\d+)\s+(.+)$/su;

const bare = (label: string): string => label.replace(/^[@#]/u, "");

/**
 * The chip for one link. With its node gone the kind is read off the link:
 * an item and a number is a task, an item alone an artifact, no item a seat.
 */
export const mentionChipOf = (
  link: Pick<MentionLinkAt, "target" | "label">,
  nodeKindOf: (nodeId: NodeId) => NodeKind | undefined,
): MentionChip => {
  const ref = mentionRefOf(link.target, nodeKindOf);
  const numbered = NUMBERED.exec(link.label);
  const kind: ResourceKind = ref?.kind ?? (link.target.item === undefined ? "seat" : numbered ? "task" : "artifact");
  const chip = kind === "task" && numbered
    ? { kind, label: numbered[2]!, number: Number(numbered[1]) }
    : { kind, label: bare(link.label) };
  return ref === undefined ? chip : { ...chip, ref };
};

/** A text cut at its mention links: plain text, and a chip for each link. */
export type MentionPart = { readonly text: string } | { readonly chip: MentionChip };

export const mentionChipParts = (
  text: string,
  nodeKindOf: (nodeId: NodeId) => NodeKind | undefined,
): ReadonlyArray<MentionPart> => {
  const parts: MentionPart[] = [];
  let at = 0;
  for (const link of mentionLinksOf(text)) {
    if (link.start > at) parts.push({ text: text.slice(at, link.start) });
    parts.push({ chip: mentionChipOf(link, nodeKindOf) });
    at = link.end;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
};

/** Open what a mention names: a seat's terminal, a page, or the task or artifact selected on its node. */
export const openMention = (ref: MentionRef): void => {
  matchMention<void>(ref, {
    seat: (seat) => void activateNodeSurface(seat.nodeId),
    page: (page) => void activateNodeSurface(page.nodeId),
    task: (task) => openWorkDetail(task.nodeId, { itemId: task.taskId }),
    artifact: (artifact) => openWorkDetail(artifact.nodeId, { itemId: artifact.artifactId }),
  });
};
