import { Schema } from "effect";
import type { NodeKind } from "./model/kinds";
import { mentionLinksOf, MENTION_KIND_OF_NODE, type MentionableNodeKind, type MentionTarget } from "./mention";

/**
 * Mentions in a briefing (docs/plans/0.11/08 B2): what `junto onboard`,
 * `junto references read` and the overseer `briefing read` return beside a
 * text the operator wrote as a document, the region instruction, the app
 * briefing or a reference.
 *
 * The text is returned exactly as written: nothing is expanded into it.
 * Beside it, one entry per distinct thing linked, in order of first
 * appearance, each link parsed by `parseMentionHref` and resolved against the
 * reading seat's canvas:
 *
 *   label      the link text as written at its first appearance
 *   ref        the `junto://` link as written there
 *   kind       seat, task, artifact or page, as `mentionRefOf` names them;
 *              node for any other node kind, or a task board or an Artifacts
 *              node linked without an item; missing when the node or the
 *              item no longer exists. A link with an item names a task when
 *              its node is a task board holding that task, and otherwise an
 *              artifact by its id wherever it now lives: artifacts move
 *              (0.11/10), so the node in the link is only a hint
 *   id         the item id for a task or an artifact, else the node id; for
 *              missing, the id the link names (its item, else its node)
 *   title      the current title, absent for missing
 *   reachable  whether the reading seat can act on it: a seat it is wired
 *              to (or itself), a task node it reaches as task commands do,
 *              any other node in its region reach. A task or an artifact is
 *              judged on the node it lives on, never the link's. Never true
 *              for missing
 *
 * A link that no longer resolves is listed as missing, never dropped and
 * never an error. A link that is not a `junto://` mention (an https link, a
 * malformed ref) is text, not a mention, and is not listed. Two links to the
 * same node and item are one entry, whatever canvas name each was written
 * with. The field is left out when a text links nothing.
 */

export const BRIEFING_MENTION_KINDS = ["seat", "task", "artifact", "page", "node", "missing"] as const;
export const BriefingMentionKind = Schema.Literals(BRIEFING_MENTION_KINDS);
export type BriefingMentionKind = typeof BriefingMentionKind.Type;

export const BriefingMention = Schema.Struct({
  label: Schema.String,
  ref: Schema.String,
  kind: BriefingMentionKind,
  id: Schema.String,
  title: Schema.optionalKey(Schema.String),
  reachable: Schema.Boolean,
});
export type BriefingMention = typeof BriefingMention.Type;

export const BriefingMentions = Schema.Array(BriefingMention);
export type BriefingMentions = typeof BriefingMentions.Type;

/** One distinct link in a text: its target, and its label and href as first written. */
export type BriefingLink = {
  readonly target: MentionTarget;
  readonly label: string;
  readonly ref: string;
};

const targetKey = (target: MentionTarget): string => (target.item === undefined ? target.nodeId : `${target.nodeId}:${target.item}`);

/** Each distinct mention link in a text, in order of first appearance. */
export const briefingLinksOf = (text: string): ReadonlyArray<BriefingLink> => {
  const seen = new Set<string>();
  const links: BriefingLink[] = [];
  for (const { target, label, start, end } of mentionLinksOf(text)) {
    const key = targetKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    // The whole link is `[label](href)`, and an href holds no `(` or `)`.
    const whole = text.slice(start, end);
    links.push({ target, label, ref: whole.slice(whole.lastIndexOf("](") + 2, -1) });
  }
  return links;
};

/** What the reader's canvas says of a linked node, or of the item a link names. */
export type BriefingNodeFacts = {
  readonly kind: NodeKind;
  readonly title: string;
  readonly reachable: boolean;
};

/**
 * What the reader resolved for one link. A link without an item is its
 * node, if it exists. A link with an item is the item, found as a task or
 * an artifact, or undefined when it is gone; its node is only a hint.
 */
export type BriefingLinkFacts = {
  readonly node: BriefingNodeFacts | undefined;
  readonly item?: {
    readonly kind: "task" | "artifact";
    readonly title: string;
    /** Judged on the node the item lives on. */
    readonly reachable: boolean;
  } | undefined;
};

/**
 * How a link's item is read: as a task when the link's node is a task board,
 * else as an artifact, by its id, wherever it lives. Undefined for a link
 * without an item.
 */
export const briefingItemKind = (target: MentionTarget, nodeKind: NodeKind | undefined): "task" | "artifact" | undefined =>
  target.item === undefined ? undefined : nodeKind === "task" ? "task" : "artifact";

const missing = (link: BriefingLink): BriefingMention => ({
  label: link.label,
  ref: link.ref,
  kind: "missing",
  id: link.target.item ?? link.target.nodeId,
  reachable: false,
});

/** One link resolved, by the rule above. */
export const briefingMentionOf = (link: BriefingLink, facts: BriefingLinkFacts): BriefingMention => {
  if (link.target.item !== undefined) {
    const { item } = facts;
    return item === undefined
      ? missing(link)
      : { label: link.label, ref: link.ref, kind: item.kind, id: link.target.item, title: item.title, reachable: item.reachable };
  }
  const { node } = facts;
  if (node === undefined) return missing(link);
  const base = { label: link.label, ref: link.ref, reachable: node.reachable };
  const mentionKind = Object.hasOwn(MENTION_KIND_OF_NODE, node.kind)
    ? MENTION_KIND_OF_NODE[node.kind as MentionableNodeKind]
    : undefined;
  const kind: BriefingMentionKind = mentionKind === "seat" || mentionKind === "page" ? mentionKind : "node";
  return { ...base, kind, id: link.target.nodeId, title: node.title };
};
