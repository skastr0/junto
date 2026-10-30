/**
 * What a composer may mention, and how a query narrows it (plan 0.10, 03
 * sections 2 and 3), one rule for the desktop's combobox and the phone's
 * picker. `mentionableNodesFrom` decides the scope; this decides what each
 * node offers and which of those a typed query matches.
 *
 * Pure, and no React: the desktop's hooks (`renderer/lib/mention-sources.ts`)
 * and main's `mentions.candidates` both call these, so the two cannot drift.
 */
import type { Node } from "./model";
import type { NodeKind } from "./model/kinds";
import { titleOf } from "./model/title";
import type { MentionRef } from "./mention";
import type { ItemId, NodeId } from "./wire/ids";
import type { ReachNode } from "./region-reach";

/** The characters a mention is typed with: `@` names a seat or a page, `#` a task or an artifact, `[[` links an artifact by title. */
export type MentionTrigger = "@" | "#" | "[[";

/** The character a mention of this kind is typed with. */
export const triggerOf = (ref: MentionRef): MentionTrigger =>
  ref.kind === "seat" || ref.kind === "page" ? "@" : "#";

/** Something a composer offers to mention: what it names and what its chip says. */
export type MentionCandidate = {
  readonly ref: MentionRef;
  /** The chip's text, trigger included: `@product-feed`, `#42 fix tabs`. */
  readonly label: string;
  /** The bare name or title, without the trigger or a task's number; a hand-made candidate may leave it out. */
  readonly title?: string;
  /** A second line of words, such as the region path when two names match. */
  readonly detail?: string;
  /** The candidate's state in words, such as "not running, mail wakes it". */
  readonly note?: string;
};

/** A candidate the builder made: its bare title is always there, for a phone's chip. */
export type NamedMentionCandidate = MentionCandidate & { readonly title: string };

/** One task or artifact on its node, as a composer has read it. */
export type MentionItem = {
  readonly id: ItemId;
  readonly title: string;
  /** A task's per-canvas number (04), shown first: `#42 fix tabs`. */
  readonly number?: number;
  /** Its state in words, such as "done". */
  readonly note?: string;
};

export type MentionItems = {
  readonly tasksOf?: (nodeId: NodeId) => ReadonlyArray<MentionItem>;
  readonly artifactsOf?: (nodeId: NodeId) => ReadonlyArray<MentionItem>;
};

const seatCandidate = (nodeId: NodeId, name: string): NamedMentionCandidate => ({
  ref: { kind: "seat", nodeId },
  label: `@${name}`,
  title: name,
});

const itemLabel = (item: MentionItem): string =>
  item.number === undefined ? `#${item.title}` : `#${item.number} ${item.title}`;

const withNote = <C extends MentionCandidate>(candidate: C, note: string | undefined): C =>
  note === undefined ? candidate : { ...candidate, note };

/**
 * The candidates the nodes make: an agent is a seat, a page is itself, a task
 * board or an Artifacts node offers its items. Anything else, a peer row
 * included (it acts from its own machine), offers nothing.
 */
export const candidatesOfNodes = (
  canvas: { readonly nodes: ReadonlyMap<MentionRef["nodeId"], Node> },
  nodes: ReadonlyArray<Pick<ReachNode, "id" | "kind">>,
  items: MentionItems = {},
): ReadonlyArray<NamedMentionCandidate> =>
  nodes.flatMap((reach): ReadonlyArray<NamedMentionCandidate> => {
    const node = canvas.nodes.get(reach.id);
    if (node === undefined) return [];
    switch (node.kind as NodeKind) {
      case "agent":
        return [seatCandidate(reach.id, titleOf(node))];
      case "page":
        return [{ ref: { kind: "page", nodeId: reach.id }, label: `@${titleOf(node)}`, title: titleOf(node) }];
      case "task":
        return (items.tasksOf?.(reach.id) ?? []).map((item) =>
          withNote(
            {
              ref: { kind: "task", nodeId: reach.id, taskId: item.id },
              label: itemLabel(item),
              title: item.title,
            },
            item.note,
          ),
        );
      case "artifacts":
        return (items.artifactsOf?.(reach.id) ?? []).map((item) =>
          withNote(
            {
              ref: { kind: "artifact", nodeId: reach.id, artifactId: item.id },
              label: `#${item.title}`,
              title: item.title,
            },
            item.note,
          ),
        );
      default:
        return [];
    }
  });

/** The seats wired to a seat: an `@` names them, whatever region they sit in. */
export const connectedSeatCandidates = (
  seats: ReadonlyArray<{ readonly nodeId: string; readonly name: string }>,
): ReadonlyArray<NamedMentionCandidate> =>
  seats.map((seat) => ({
    ref: { kind: "seat", nodeId: seat.nodeId as NodeId },
    label: `@${seat.name}`,
    title: seat.name,
  }));

/** The trigger a chip shows: `#42 fix tabs` for a task, `#Pricing notes` for an artifact. */
const withoutTrigger = (candidate: MentionCandidate, trigger: MentionTrigger): string =>
  (candidate.label.startsWith(trigger) ? candidate.label.slice(trigger.length) : candidate.label).toLowerCase();

/**
 * The candidates for a query: those of its trigger whose text starts with
 * what was typed, then those that contain it. `[[` offers artifacts by title
 * alone (the `[[ ]]` link), so its label is the title without a `#`.
 */
export const filterCandidates = (
  candidates: ReadonlyArray<MentionCandidate>,
  query: { readonly trigger: MentionTrigger; readonly query: string },
): ReadonlyArray<MentionCandidate> => {
  const typed = query.query.toLowerCase();
  const own =
    query.trigger === "[["
      ? candidates.filter((candidate) => candidate.ref.kind === "artifact")
      : candidates.filter((candidate) => triggerOf(candidate.ref) === query.trigger);
  const name = (candidate: MentionCandidate): string => withoutTrigger(candidate, query.trigger === "[[" ? "#" : query.trigger);
  const starts = own.filter((candidate) => name(candidate).startsWith(typed));
  const contains = own.filter((candidate) => !starts.includes(candidate) && name(candidate).includes(typed));
  return [...starts, ...contains];
};

  trigger === "[[" ? `[[${candidate.title}]]` : candidate.label;
