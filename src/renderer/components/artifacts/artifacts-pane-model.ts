/**
 * The Artifacts node's pure parts: which rows the sidebar shows, the text
 * patch a document edit becomes, and how an anchor and an author read.
 */
import type { ArtifactOp, ArtifactType, TextPatch } from "@shared/artifact";
import type { ArtifactPendingWrite } from "../../lib/artifacts-source";
import type { ArtifactHead } from "@shared/resource-ipc";
import type { ResourceActor } from "@shared/resource-command";
import type { ThreadAuthor } from "../../lib/subject-threads-source";
import type { Anchor } from "@shared/thread-subject";

export type TypeFilter = ArtifactType | "all";

export interface SidebarFilter {
  readonly type: TypeFilter;
  readonly query: string;
  readonly archived: boolean;
}

/** The rows the sidebar lists: by type, by a case-blind title match, live or archived. */
export const visibleArtifacts = (
  entries: ReadonlyArray<ArtifactHead>,
  filter: SidebarFilter,
): ReadonlyArray<ArtifactHead> => {
  const query = filter.query.trim().toLowerCase();
  return entries.filter(
    ({ artifact }) =>
      artifact.archived === filter.archived &&
      (filter.type === "all" || artifact.type === filter.type) &&
      (query.length === 0 || artifact.title.toLowerCase().includes(query)),
  );
};

/**
 * The one splice that turns `before` into `after`: the common head and tail
 * stay, the middle is replaced. Null when nothing changed.
 */
export const textSplice = (before: string, after: string): TextPatch | null => {
  if (before === after) return null;
  let head = 0;
  const shorter = Math.min(before.length, after.length);
  while (head < shorter && before.charCodeAt(head) === after.charCodeAt(head)) head += 1;
  let tail = 0;
  while (
    tail < shorter - head &&
    before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)
  ) {
    tail += 1;
  }
  return {
    op: "splice",
    at: head,
    remove: before.length - head - tail,
    insert: after.slice(head, after.length - tail),
  };
};

/**
 * Post a comment, saving the document first when it hangs on a text quote:
 * main checks the quote against the saved document. A refused or failed save
 * stops the post and says why; a reply or any other anchor posts as is.
 */
export const postAfterSave = async (
  anchor: Anchor | undefined,
  save: (() => Promise<string | null>) | null,
  post: () => Promise<string | null>,
): Promise<string | null> => {
  if (anchor?.kind === "text" && save !== null) {
    const unsaved = await save().then(
      (refused) =>
        refused === null
          ? null
          : `Not posted: the document did not save (${refused}). Choose Overwrite theirs or Take theirs above, then post again.`,
      () => "Not posted: the document could not be saved. Try again.",
    );
    if (unsaved !== null) return unsaved;
  }
  return post();
};

const QUOTE_MAX = 48;

/** Where a thread hangs, said briefly. */
export const anchorLabel = (anchor: Anchor | undefined): string => {
  if (anchor === undefined) return "Whole artifact";
  switch (anchor.kind) {
    case "whole":
      return "Whole artifact";
    case "text":
      return anchor.quote.length > QUOTE_MAX ? `"${anchor.quote.slice(0, QUOTE_MAX - 1)}…"` : `"${anchor.quote}"`;
    case "cells":
      return `Cells ${anchor.range}`;
    case "box":
      return `Area at ${Math.round(anchor.x)}, ${Math.round(anchor.y)}`;
    case "lines":
      return `${anchor.file} line ${String(anchor.from)}`;
  }
};

/** Who wrote it, as the operator reads it. A seat's name is resolved by the caller. */
export const actorLabel = (actor: ResourceActor | ThreadAuthor, seatName?: (nodeId: string) => string | undefined): string => {
  switch (actor.kind) {
    case "operator":
      return "You";
    case "seat":
      return seatName?.(actor.nodeId) ?? actor.nodeId;
    case "automation":
      return "Automation";
  }
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A short age: now, 5m, 3h, 2d, or the date. */
export const ageLabel = (at: number, now: number): string => {
  const age = Math.max(0, now - at);
  if (age < MINUTE) return "now";
  if (age < HOUR) return `${Math.floor(age / MINUTE)}m`;
  if (age < DAY) return `${Math.floor(age / HOUR)}h`;
  if (age < 7 * DAY) return `${Math.floor(age / DAY)}d`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

export const TYPE_NOUN: { readonly [T in ArtifactType]: string } = {
  link: "Link",
  document: "Document",
  pad: "Pad",
  sheet: "Sheet",
  file: "File",
};

/** Is this an http(s) URL a link may point at. */
export const isLinkUrl = (value: string): boolean => {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

/** What a write does, as a row names it. */
export const opLabel = (op: ArtifactOp): string => {
  switch (op.op) {
    case "create":
      return `Create ${op.title}`;
    case "edit":
      return op.edit.kind === "replace" ? "Replace the content" : "Edit";
    case "retitle":
      return `Rename to ${op.title}`;
    case "archive":
      return "Archive";
    case "restore":
      return "Restore";
    case "tasks":
      return "Change its tasks";
  }
};

/**
 * How one unruled write reads: `pending` draws dashed and quiet, `at_risk`
 * says why it may not land. Without an overlay it is queued and no more is known.
 */
export const pendingWriteLine = (
  write: ArtifactPendingWrite,
): { readonly tone: "pending" | "risk"; readonly text: string } => {
  const overlay = write.overlay;
  if (overlay === undefined || overlay.status === "pending") {
    return { tone: "pending", text: "Waiting for the editing machine" };
  }
  if (overlay.waiting !== undefined) {
    return { tone: "risk", text: "Waiting for this artifact's latest version to arrive here" };
  }
  return { tone: "risk", text: `Would be refused now: ${overlay.refusal.message}` };
};
