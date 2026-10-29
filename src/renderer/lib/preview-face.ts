import type { ArtifactBody, ArtifactType } from "@shared/artifact";
import { parseMentionHref, type MentionKind, type MentionTarget } from "@shared/mention";
import type { KindIconKind } from "@shared/kind-icon";
import type { TaskNumber, TaskState, TaskView } from "@shared/task-model";
import { SeatUrgency } from "@shared/wire/urgency";
import type { KindState } from "./kind-band";

// The preview card's face: what a Junto thing embedded in an artifact shows (a document's block
// embed, a pad's card). Pure data: the card draws it, `usePreviewFace` reads it off the live
// stores, a gallery hands it fixtures. Same face, same card.

const S = SeatUrgency.group;

/** A task's layers as the kind band counts them: the earlier layers finished, the current one open, asking, or waiting. */
export type PreviewTaskLedger = {
  readonly finished: number;
  readonly open: number;
  readonly asks: number;
  readonly stuck: number;
  readonly backlog: number;
};

export type PreviewCardFace =
  | {
      readonly kind: "task";
      readonly id: string;
      readonly number?: TaskNumber;
      readonly title: string;
      readonly state: TaskState;
      readonly assignee?: { readonly id: string; readonly name: string; readonly harness?: string };
      readonly ledger?: PreviewTaskLedger;
    }
  | {
      readonly kind: "seat";
      /** The seat's node id: picks the portrait. */
      readonly id: string;
      readonly name: string;
      readonly harness?: string;
      readonly state: KindState;
      /** What the seat says now, as its canvas line says it. */
      readonly line: string;
    }
  | {
      readonly kind: "artifact";
      readonly id: string;
      readonly type: ArtifactType;
      readonly title: string;
      readonly version: number;
      /** The body's first lines; the card shows two. */
      readonly lines: ReadonlyArray<string>;
    }
  | { readonly kind: "page"; readonly id: string; readonly title: string; readonly url?: string; readonly state: KindState }
  /** Not drawn from a live thing: still loading, or gone or out of reach. Drawn greyed under its label, never vanished. */
  | { readonly kind: "missing"; readonly label: string; readonly reason: "loading" | "gone"; readonly of?: MentionKind };

export type PreviewCardKind = PreviewCardFace["kind"];

/** A task's state as a kind seat's ring says it. */
export const taskKindState = (state: TaskState): KindState => {
  switch (state) {
    case "working":
      return S.working;
    case "input-required":
      return S.waiting;
    case "in-review":
      return S.review;
    case "done":
      return S.done;
    case "canceled":
    case "archived":
      return S.offline;
    case "backlog":
    case "assigned":
      return S.resting;
  }
};

/** One task's layers as ledger counts: each earlier layer finished, then where the current one stands. */
export const taskLedgerOf = (task: Pick<TaskView, "layers" | "current">): PreviewTaskLedger => {
  const { state } = task.current;
  return {
    finished: task.layers.length + (state === "done" ? 1 : 0),
    open: state === "assigned" || state === "working" || state === "in-review" ? 1 : 0,
    asks: state === "input-required" ? 1 : 0,
    stuck: 0,
    backlog: state === "backlog" ? 1 : 0,
  };
};

/** The kind icon an artifact type wears. */
export const artifactIconKind = (type: ArtifactType): KindIconKind => {
  switch (type) {
    case "link":
      return "link";
    case "file":
      return "file";
    default:
      return "artifacts";
  }
};

export { artifactFirstLines } from "@shared/artifact-lines";

/** A link to a Junto thing, as it is written or pasted: the bare href, `[label](href)`, or the embed `![label](href)`. */
export type PreviewLink = { readonly target: MentionTarget; readonly href: string; readonly label?: string };

const LINK_FORM = /^!?\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)\)$/su;

/**
 * Whether a text names a Junto thing a preview card can draw, and which: the
 * one grammar the document's embeds and the pad's paste both read. A plain
 * web link, or anything else, is undefined. The kind is the canvas's to say
 * (`mentionRefOf`); a target whose node is gone still parses, and its card
 * says so.
 */
export const parsePreviewLink = (text: string): PreviewLink | undefined => {
  const trimmed = text.trim();
  const linked = LINK_FORM.exec(trimmed);
  const href = linked ? linked[2]! : trimmed;
  const target = parseMentionHref(href);
  if (target === undefined) return undefined;
  const label = linked?.[1]?.replace(/\\([\\[\]])/gu, "$1");
  return label ? { target, href, label } : { target, href };
};
