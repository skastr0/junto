/**
 * The Cmd+T desk's view state, pure (0.12): what the operator left open and
 * where in it they were, so the same desk comes back after a close, a quit or
 * a reboot. It holds no words of the writing: the text is product-documents'
 * draft store, and this is only the pointer to it and the place in it.
 *
 * Stored one row per canvas in `view_capture_desks` (view state, machine
 * local), through the same seam every other view-state row takes. The shape
 * here is what the renderer reads and writes; the row is made safe on the way
 * in, because a row can outlive the artifact it names.
 */
import type { ItemId } from "@shared/resource-command";
import type { NodeId } from "@shared/physics/schema";

/** What the writing half was showing: a new capture, or one artifact. */
export type CaptureDeskOpen =
  | { readonly kind: "new" }
  | { readonly kind: "artifact"; readonly nodeId: string; readonly artifactId: string };

export type CaptureDeskState = {
  readonly open: CaptureDeskOpen;
  readonly query: string;
  /** The row the list had focused, by artifact id. */
  readonly focused: string | null;
  /** The writing's caret, as a document offset; null when the editor had none yet. */
  readonly caret: number | null;
  /** The writing's scroll, in px. */
  readonly scrollWriting: number;
  /** The captures list's scroll, in px. */
  readonly scrollList: number;
};

/** A desk nobody has touched: a new capture, no query, nothing focused. */
export const EMPTY_CAPTURE_DESK: CaptureDeskState = {
  open: { kind: "new" },
  query: "",
  focused: null,
  caret: null,
  scrollWriting: 0,
  scrollList: 0,
};

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** A stored offset: a whole number at or above zero, or null. */
const offset = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.trunc(value));
};

const deskOpenOf = (row: Record<string, unknown>): CaptureDeskOpen => {
  if (row["open_kind"] !== "artifact") return { kind: "new" };
  const nodeId = text(row["open_node_id"]);
  const artifactId = text(row["open_artifact_id"]);
  // Half a pointer is no pointer: an artifact is named by its node and its id.
  if (nodeId === "" || artifactId === "") return { kind: "new" };
  return { kind: "artifact", nodeId, artifactId };
};

/**
 * A stored row as the desk reads it. Unknown fields are dropped, a missing or
 * malformed value takes its default, and a negative offset is clamped: a row
 * is never trusted to be well formed just because this build wrote it.
 */
export const captureDeskOf = (row: unknown): CaptureDeskState => {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return EMPTY_CAPTURE_DESK;
  const stored = row as Record<string, unknown>;
  const focused = text(stored["focused_artifact_id"]);
  return {
    open: deskOpenOf(stored),
    query: text(stored["query"]),
    focused: focused === "" ? null : focused,
    caret: offset(stored["caret"]),
    scrollWriting: offset(stored["scroll_writing"]) ?? 0,
    scrollList: offset(stored["scroll_list"]) ?? 0,
  };
};

/**
 * The desk to reopen: the saved artifact while the list still offers it, and
 * the saved query and scroll either way. A row that names an artifact the
 * canvas no longer has (deleted, archived, on another canvas) reopens a new
 * capture with that query rather than a preview of nothing; a focus that is
 * gone goes with it.
 */
export const reopenedDesk = (
  saved: CaptureDeskState,
  offered: (artifactId: string) => boolean,
): CaptureDeskState => {
  const open =
    saved.open.kind === "artifact" && offered(saved.open.artifactId) ? saved.open : { kind: "new" as const };
  const focused = saved.focused !== null && offered(saved.focused) ? saved.focused : null;
  return { ...saved, open, focused };
};

/** The row this state writes, in the columns `view_capture_desks` holds. */
export const captureDeskRowOf = (
  state: CaptureDeskState,
): {
  readonly open_kind: "new" | "artifact";
  readonly open_node_id: string | null;
  readonly open_artifact_id: string | null;
  readonly query: string;
  readonly focused_artifact_id: string | null;
  readonly caret: number | null;
  readonly scroll_writing: number;
  readonly scroll_list: number;
} => ({
  open_kind: state.open.kind,
  open_node_id: state.open.kind === "artifact" ? state.open.nodeId : null,
  open_artifact_id: state.open.kind === "artifact" ? state.open.artifactId : null,
  query: state.query,
  focused_artifact_id: state.focused,
  caret: state.caret,
  scroll_writing: Math.max(0, Math.trunc(state.scrollWriting)),
  scroll_list: Math.max(0, Math.trunc(state.scrollList)),
});

/** The ref as the editor and the move column take it, or undefined for a new capture. */
export const openRefOf = (state: CaptureDeskState): { readonly nodeId: NodeId; readonly artifactId: ItemId } | undefined =>
  state.open.kind === "artifact"
    ? { nodeId: state.open.nodeId as NodeId, artifactId: state.open.artifactId as ItemId }
    : undefined;
