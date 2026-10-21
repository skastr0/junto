import { Schema } from "effect";
import type { NodeKind } from "./model/kinds";
import { formatNodeRef, parseNodeRef } from "./node-ref";
import { NodeId } from "./physics/schema";
import { ItemId } from "./work-ids";

/**
 * Mentions (docs/plans/0.10/03 section 1): one way every composer names a
 * seat, a task, an artifact or a page, and one way every reader finds them.
 *
 * The text is the source of truth. A mention is an inline markdown link whose
 * destination is the node's ref (node-ref.ts), with `&item=<ItemId>` for a
 * task or an artifact on its node:
 *
 *   [@product-feed](junto://canvas/factory?node=agent-01M...)
 *   [#42 fix tabs](junto://canvas/factory?node=task-01M...&item=01M...)
 *
 * Nothing keys on the canvas name in the link: it is written for whoever
 * reads the text, and a reader takes the canvas from where the text lives,
 * so a renamed canvas's old links still resolve. The kind is never in the
 * link: it is the node's own (an agent node is a seat, a task board a task,
 * and so on), so the link cannot disagree with the canvas. Reading a mention
 * therefore takes the canvas's node kinds; parsing the links alone does not.
 *
 * Who may be mentioned and what a mention does are each composer's own
 * (availability sources and side effect hooks); nothing here decides either.
 */

/** A task on its board: the item it is (work-ids.ts). */
export const TaskMention = Schema.Struct({ kind: Schema.Literal("task"), nodeId: NodeId, taskId: ItemId });
export const SeatMention = Schema.Struct({ kind: Schema.Literal("seat"), nodeId: NodeId });
/** An artifact in its Artifacts node: the item it is (work-ids.ts). */
export const ArtifactMention = Schema.Struct({
  kind: Schema.Literal("artifact"),
  nodeId: NodeId,
  artifactId: ItemId,
});
export const PageMention = Schema.Struct({ kind: Schema.Literal("page"), nodeId: NodeId });

/** What a mention names. Closed: a new kind is a new member here, and every match breaks until it is handled. */
export const MentionRef = Schema.Union([SeatMention, TaskMention, ArtifactMention, PageMention]);
export type MentionRef = typeof MentionRef.Type;
export type MentionKind = MentionRef["kind"];
export type MentionOf<K extends MentionKind> = Extract<MentionRef, { readonly kind: K }>;

/** The node kinds a mention can name, and the mention each makes. Every other node kind names nothing. */
export const MENTION_KIND_OF_NODE = {
  agent: "seat",
  task: "task",
  artifacts: "artifact",
  page: "page",
} as const satisfies Partial<Record<NodeKind, MentionKind>>;
export type MentionableNodeKind = keyof typeof MENTION_KIND_OF_NODE;

/** Exhaustive by kind: a missing case does not compile. */
export const matchMention = <A>(
  ref: MentionRef,
  cases: { readonly [K in MentionKind]: (ref: MentionOf<K>) => A },
): A => (cases[ref.kind] as (ref: MentionRef) => A)(ref);

/** The item a mention names on its node, for the link's `item`. */
const itemOf = (ref: MentionRef): ItemId | undefined =>
  matchMention<ItemId | undefined>(ref, {
    seat: () => undefined,
    task: (task) => task.taskId,
    artifact: (artifact) => artifact.artifactId,
    page: () => undefined,
  });

// --- the link -----------------------------------------------------------------

const ITEM = "&item=";

/**
 * The node's ref on `canvasName`, with `&item=<ItemId>` for a task or an
 * artifact. Throws as formatNodeRef does on a canvas name that is not one.
 */
export const mentionHref = (ref: MentionRef, canvasName: string): string => {
  const item = itemOf(ref);
  // An ItemId is a ULID: nothing in it needs encoding.
  return `${formatNodeRef({ canvasName, nodeId: ref.nodeId })}${item === undefined ? "" : `${ITEM}${item}`}`;
};

/** A link's target before the canvas says what kind of node it is. The link's canvas name is not kept. */
export type MentionTarget = { readonly nodeId: NodeId; readonly item?: ItemId };

const decodeNodeId = Schema.decodeUnknownOption(NodeId);
const decodeItemId = Schema.decodeUnknownOption(ItemId);

/** A link's target, or undefined unless the href is a node ref in canonical form, with at most an ItemId after it. */
export const parseMentionHref = (href: string): MentionTarget | undefined => {
  const at = href.indexOf(ITEM);
  const base = at < 0 ? href : href.slice(0, at);
  const node = parseNodeRef(base);
  if (!node.ok) return undefined;
  const nodeId = decodeNodeId(node.value.nodeId);
  if (nodeId._tag === "None") return undefined;
  if (at < 0) return { nodeId: nodeId.value };
  const item = decodeItemId(href.slice(at + ITEM.length));
  return item._tag === "None" ? undefined : { nodeId: nodeId.value, item: item.value };
};

/**
 * The mention a target makes on a canvas, given the kind of each node: a
 * seat or a page takes no item, a task or an artifact needs one. Undefined
 * when the node is gone or names nothing.
 */
export const mentionRefOf = (
  target: MentionTarget,
  nodeKindOf: (nodeId: NodeId) => NodeKind | undefined,
): MentionRef | undefined => {
  const nodeKind = nodeKindOf(target.nodeId);
  if (nodeKind === undefined || !Object.hasOwn(MENTION_KIND_OF_NODE, nodeKind)) return undefined;
  const kind = MENTION_KIND_OF_NODE[nodeKind as MentionableNodeKind];
  const { nodeId, item } = target;
  switch (kind) {
    case "seat":
      return item === undefined ? { kind, nodeId } : undefined;
    case "page":
      return item === undefined ? { kind, nodeId } : undefined;
    case "task":
      return item === undefined ? undefined : { kind, nodeId, taskId: item };
    case "artifact":
      return item === undefined ? undefined : { kind, nodeId, artifactId: item };
  }
};

/** A label as link text: one line, brackets and backslashes escaped. */
const escapeLabel = (label: string): string => label.replace(/\s+/g, " ").trim().replace(/[\\[\]]/g, (c) => `\\${c}`);
const unescapeLabel = (label: string): string => label.replace(/\\([\\[\]])/g, "$1");

/** `[label](href)`: `@name` for a seat or a page, `#42 title` for a task, as the composer chooses. */
export const mentionLink = (ref: MentionRef, label: string, canvasName: string): string => {
  const text = escapeLabel(label);
  if (text === "") throw new RangeError("a mention needs a label");
  return `[${text}](${mentionHref(ref, canvasName)})`;
};

/** One mention link in a text, by code-unit offsets: `text.slice(start, end)` is the whole link. */
export type MentionLinkAt = {
  readonly target: MentionTarget;
  readonly label: string;
  readonly start: number;
  readonly end: number;
};

const LINK = /\[((?:\\[\\[\]]|[^\\[\]\n])+)\]\((junto:\/\/canvas\/[^\s()]+)\)/g;

/** Every mention link in a text, in text order. Links that are not canonical mention links are left as text. */
export const mentionLinksOf = (text: string): ReadonlyArray<MentionLinkAt> => {
  const links: MentionLinkAt[] = [];
  for (const match of text.matchAll(LINK)) {
    const target = parseMentionHref(match[2]!);
    if (target === undefined) continue;
    links.push({ target, label: unescapeLabel(match[1]!), start: match.index, end: match.index + match[0].length });
  }
  return links;
};

/** One mention in a text, resolved against its canvas. */
export type MentionAt = {
  readonly ref: MentionRef;
  readonly label: string;
  readonly start: number;
  readonly end: number;
};

/** Every mention in a text, in text order, that names a node of a kind that can be mentioned. */
export const mentionsOf = (
  text: string,
  nodeKindOf: (nodeId: NodeId) => NodeKind | undefined,
): ReadonlyArray<MentionAt> =>
  mentionLinksOf(text).flatMap(({ target, label, start, end }) => {
    const ref = mentionRefOf(target, nodeKindOf);
    return ref === undefined ? [] : [{ ref, label, start, end }];
  });

/** One key per thing mentioned, whatever canvas name its link was written with. */
export const mentionKey = (ref: MentionRef): string => {
  const item = itemOf(ref);
  return item === undefined ? `${ref.kind}:${ref.nodeId}` : `${ref.kind}:${ref.nodeId}:${item}`;
};

/** Each thing a text mentions, once, in the order first named. */
export const mentionedOnce = (mentions: ReadonlyArray<Pick<MentionAt, "ref">>): ReadonlyArray<MentionRef> => {
  const seen = new Set<string>();
  const out: MentionRef[] = [];
  for (const { ref } of mentions) {
    const key = mentionKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
};
