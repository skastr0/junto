/**
 * View state (0.11, 04): how the operator arranged Junto, in `junto.db`.
 *
 * One row per thing, written as it changes, last write wins. The snapshot is
 * read once at window load; the IPC pushes each change to every window. This
 * is machine-local, so it is never journalled and never crosses.
 *
 * Sparse by construction: a node the operator never touched has no row, and a
 * write that returns a row to its default deletes it. `read` fills the
 * defaults (`@shared/view-state`).
 */
import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient, SqlError } from "effect/unstable/sql";
import type {
  CaptureDesk,
  CaptureDraft,
  ViewArtifactsFilter,
  ViewCommandGroups,
  ViewCommandSlot,
  ViewNodeState,
  ViewStateSnapshot,
  ViewStateWrite,
} from "@shared/view-state";
import type { ArtifactLabel } from "@shared/artifact-labels";
import { KIND_TABLES } from "../model/state-schema";
import { StateTransactionOperation } from "../state/service";
import { removeViewCanvas, removeViewNodes } from "./remove";

export class ViewStatePersistenceError extends Schema.TaggedError<ViewStatePersistenceError>()(
  "ViewStatePersistenceError",
  { operation: Schema.String, message: Schema.String, cause: Schema.Unknown },
) {}

const persistence =
  (operation: string) =>
  (error: SqlError.SqlError | Schema.SchemaError): ViewStatePersistenceError =>
    error instanceof ViewStatePersistenceError
      ? error
      : ViewStatePersistenceError.make({ operation, message: error.message, cause: error });

type SlotRow = {
  readonly canvas_name: string;
  readonly slot: number;
  readonly kind: string;
  readonly node_id: string | null;
};
type MemberRow = {
  readonly canvas_name: string;
  readonly slot: number;
  readonly position: number;
  readonly node_id: string;
};
type ExtraRow = {
  readonly canvas_name: string;
  readonly group_index: number;
  readonly position: number;
  readonly node_id: string;
};
type ArtifactsFilterRow = {
  readonly canvas_name: string;
  readonly node_id: string;
  readonly type: string;
  readonly archived: number;
};
type PickedLabelRow = {
  readonly canvas_name: string;
  readonly node_id: string;
  readonly label: ArtifactLabel;
  readonly position: number;
};
type TasksFilterRow = {
  readonly canvas_name: string;
  readonly node_id: string;
  readonly state: string;
};
type OpenItemRow = {
  readonly canvas_name: string;
  readonly node_id: string;
  readonly kind: string;
  readonly item: string;
};
type ExpandedFolderRow = {
  readonly canvas_name: string;
  readonly node_id: string;
  readonly path: string;
  readonly position: number;
};
type CollapsedSidebarRow = {
  readonly canvas_name: string;
  readonly node_id: string;
};
type FocusSizeRow = {
  readonly surface: string;
  readonly width: number;
  readonly height: number;
};
type CaptureInboxRow = {
  readonly canvas_name: string;
  readonly node_id: string;
};
type CaptureDraftRow = {
  readonly canvas_name: string;
  readonly draft_of: string | null;
  readonly draft_node_id: string | null;
  readonly draft_text: string;
  readonly draft_base_version: number | null;
  readonly draft_at: number;
};
type CaptureDeskRow = {
  readonly canvas_name: string;
  readonly open_kind: string;
  readonly open_node_id: string | null;
  readonly open_artifact_id: string | null;
  readonly query: string | null;
  readonly focused_artifact_id: string | null;
  readonly caret: number | null;
  readonly scroll_writing: number | null;
  readonly scroll_list: number | null;
};
type SectionRow = {
  readonly section: string;
  readonly open: number;
};

/** A write whose row belongs to a node; the canvas is the node's canvas. */
type NodeWrite = Extract<ViewStateWrite, { readonly nodeId: string }>;
const isNodeWrite = (write: ViewStateWrite): write is NodeWrite => "nodeId" in write;

/** A node's state while the snapshot is assembled; the contract's fields are readonly. */
type NodeDraft = {
  artifactsFilter?: ViewArtifactsFilter;
  tasksFilter?: ViewNodeState["tasksFilter"];
  openItem?: ViewNodeState["openItem"];
  expandedFolders?: string[];
  sidebarCollapsed?: true;
};

const EMPTY_SLOT = { kind: "empty" } as const;

/** A canvas's board while the snapshot is assembled. */
type BoardDraft = {
  slots: Array<ViewCommandSlot | undefined>;
  extras: string[][];
};

export class ViewStateRepository extends Context.Service<
  ViewStateRepository,
  {
    /** Every row this machine saved, sparse. */
    readonly snapshot: () => Effect.Effect<ViewStateSnapshot, ViewStatePersistenceError>;
    /**
     * Write one changed row (or one row's children) in one transaction.
     * False, and nothing written, when the row's node is no longer on the
     * canvas: a stale window's write cannot resurrect a removed node's rows.
     */
    readonly write: (change: ViewStateWrite) => Effect.Effect<boolean, ViewStatePersistenceError>;
    /** A canvas went: its rows go with it (the FK is the backstop). */
    readonly removeCanvas: (canvas: string) => Effect.Effect<void, ViewStatePersistenceError>;
    /** Nodes went: their rows go, and their command-group members leave their groups. */
    readonly removeNodes: (canvas: string, ids: ReadonlyArray<string>) => Effect.Effect<void, ViewStatePersistenceError>;
  }
>()("@junto/ViewStateRepository") {}

export const ViewStateRepositoryLive: Layer.Layer<ViewStateRepository, never, SqlClient.SqlClient> = Layer.effect(
  ViewStateRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    /**
     * Is this node still one of its canvas's nodes? Nodes live in one of the
     * kind tables, so the check is a union over the closed map; the table
     * names never come from a caller. A stale window's write for a node a
     * delete already took answers false and writes nothing.
     */
    const nodeExists = (canvas: string, nodeId: string) =>
      Effect.map(
        sql.unsafe<{ one: number }>(
          `${Object.values(KIND_TABLES)
            .map((table) => `SELECT 1 AS one FROM ${table} WHERE canvas_name = ?1 AND id = ?2`)
            .join(" UNION ALL ")} LIMIT 1`,
          [canvas, nodeId],
        ),
        (rows) => rows.length > 0,
      );

    const snapshot = Effect.fn("viewState.snapshot")(function* () {
      const slotRows = yield* sql<SlotRow>`
        SELECT canvas_name, slot, kind, node_id FROM view_command_slots
        ORDER BY canvas_name, slot`;
      const memberRows = yield* sql<MemberRow>`
        SELECT canvas_name, slot, position, node_id FROM view_command_slot_members
        ORDER BY canvas_name, slot, position`;
      const extraRows = yield* sql<ExtraRow>`
        SELECT canvas_name, group_index, position, node_id FROM view_command_extras
        ORDER BY canvas_name, group_index, position`;
      const filterRows = yield* sql<ArtifactsFilterRow>`
        SELECT canvas_name, node_id, type, archived FROM view_artifacts_filters
        ORDER BY canvas_name, node_id`;
      const labelRows = yield* sql<PickedLabelRow>`
        SELECT canvas_name, node_id, label, position FROM view_artifacts_filter_labels
        ORDER BY canvas_name, node_id, position`;
      const taskRows = yield* sql<TasksFilterRow>`
        SELECT canvas_name, node_id, state FROM view_tasks_filters
        ORDER BY canvas_name, node_id`;
      const openRows = yield* sql<OpenItemRow>`
        SELECT canvas_name, node_id, kind, item FROM view_open_items
        ORDER BY canvas_name, node_id`;
      const folderRows = yield* sql<ExpandedFolderRow>`
        SELECT canvas_name, node_id, path, position FROM view_expanded_folders
        ORDER BY canvas_name, node_id, position`;
      const sidebarRows = yield* sql<CollapsedSidebarRow>`
        SELECT canvas_name, node_id FROM view_collapsed_sidebars
        ORDER BY canvas_name, node_id`;
      const sizeRows = yield* sql<FocusSizeRow>`
        SELECT surface, width, height FROM view_focus_sizes ORDER BY surface`;
      const sectionRows = yield* sql<SectionRow>`
        SELECT section, open FROM view_sections ORDER BY section`;

      const inboxRows = yield* sql<CaptureInboxRow>`
        SELECT canvas_name, node_id FROM view_capture_inboxes ORDER BY canvas_name`;
      const draftRows = yield* sql<CaptureDraftRow>`
        SELECT canvas_name, draft_of, draft_node_id, draft_text, draft_base_version, draft_at
        FROM view_capture_desks WHERE draft_text IS NOT NULL ORDER BY canvas_name`;
      const deskRows = yield* sql<CaptureDeskRow>`
        SELECT canvas_name, open_kind, open_node_id, open_artifact_id, query, focused_artifact_id,
               caret, scroll_writing, scroll_list
        FROM view_capture_desks WHERE open_kind IS NOT NULL ORDER BY canvas_name`;

      const boards = new Map<string, BoardDraft>();
      const board = (canvas: string): BoardDraft => {
        const known = boards.get(canvas);
        if (known !== undefined) return known;
        const next: BoardDraft = { slots: Array.from({ length: 9 }), extras: [] };
        boards.set(canvas, next);
        return next;
      };
      for (const row of slotRows) {
        board(row.canvas_name).slots[row.slot] =
          row.kind === "fixed" && row.node_id !== null
            ? { kind: "fixed", nodeId: row.node_id }
            : { kind: "group", nodeIds: [] };
      }
      for (const row of memberRows) {
        const slot = board(row.canvas_name).slots[row.slot];
        if (slot?.kind === "group") (slot.nodeIds as string[]).push(row.node_id);
      }
      for (const row of extraRows) {
        const groups = board(row.canvas_name).extras;
        while (groups.length <= row.group_index) groups.push([]);
        groups[row.group_index]!.push(row.node_id);
      }

      const nodes = new Map<string, Map<string, NodeDraft>>();
      const node = (canvas: string, nodeId: string): NodeDraft => {
        let byNode = nodes.get(canvas);
        if (byNode === undefined) {
          byNode = new Map();
          nodes.set(canvas, byNode);
        }
        const known = byNode.get(nodeId);
        if (known !== undefined) return known;
        const next: NodeDraft = {};
        byNode.set(nodeId, next);
        return next;
      };
      const labels = new Map<string, ArtifactLabel[]>();
      for (const row of labelRows) {
        const key = `${row.canvas_name}\n${row.node_id}`;
        const held = labels.get(key);
        if (held === undefined) labels.set(key, [row.label]);
        else held.push(row.label);
      }
      for (const row of filterRows) {
        node(row.canvas_name, row.node_id).artifactsFilter = {
          type: row.type as ViewArtifactsFilter["type"],
          archived: row.archived === 1,
          labels: labels.get(`${row.canvas_name}\n${row.node_id}`) ?? [],
        };
      }
      for (const row of taskRows) {
        node(row.canvas_name, row.node_id).tasksFilter = row.state as ViewNodeState["tasksFilter"];
      }
      for (const row of openRows) {
        node(row.canvas_name, row.node_id).openItem =
          row.kind === "file"
            ? { kind: "file", path: row.item }
            : { kind: row.kind as "artifact" | "task" | "automation", id: row.item };
      }
      for (const row of folderRows) {
        const draft = node(row.canvas_name, row.node_id);
        (draft.expandedFolders ??= []).push(row.path);
      }
      for (const row of sidebarRows) node(row.canvas_name, row.node_id).sidebarCollapsed = true;

      const commandGroups: Record<string, ViewCommandGroups> = {};
      for (const [canvas, draft] of boards) {
        commandGroups[canvas] = {
          slots: draft.slots.map((slot) => slot ?? EMPTY_SLOT),
          extras: draft.extras.filter((group) => group.length > 0),
        };
      }
      const nodeState: Record<string, Record<string, ViewNodeState>> = {};
      for (const [canvas, byNode] of nodes) {
        const held: Record<string, ViewNodeState> = {};
        for (const [nodeId, draft] of byNode) held[nodeId] = draft as ViewNodeState;
        nodeState[canvas] = held;
      }
      const focusSizes: Record<string, { width: number; height: number }> = {};
      for (const row of sizeRows) focusSizes[row.surface] = { width: row.width, height: row.height };
      const sections: Record<string, boolean> = {};
      for (const row of sectionRows) sections[row.section] = row.open === 1;
      const captureInboxes: Record<string, string> = {};
      for (const row of inboxRows) captureInboxes[row.canvas_name] = row.node_id;
      const captureDrafts: Record<string, CaptureDraft> = {};
      for (const row of draftRows) {
        captureDrafts[row.canvas_name] = {
          of: row.draft_of,
          node: row.draft_node_id,
          text: row.draft_text,
          base: row.draft_base_version,
          at: Number(row.draft_at),
        };
      }
      const captureDesks: Record<string, CaptureDesk> = {};
      for (const row of deskRows) {
        captureDesks[row.canvas_name] = {
          open:
            row.open_kind === "artifact" && row.open_node_id !== null && row.open_artifact_id !== null
              ? { kind: "artifact", nodeId: row.open_node_id, artifactId: row.open_artifact_id }
              : { kind: "new" },
          query: row.query ?? "",
          focused: row.focused_artifact_id,
          caret: row.caret === null ? null : Number(row.caret),
          scrollWriting: Number(row.scroll_writing ?? 0),
          scrollList: Number(row.scroll_list ?? 0),
        };
      }
      return {
        commandGroups,
        nodes: nodeState,
        focusSizes,
        sections,
        captureInboxes,
        captureDrafts,
        captureDesks,
      } satisfies ViewStateSnapshot;
    }, Effect.mapError(persistence("snapshot")));

    const write = Effect.fn("viewState.write")(function* (change: ViewStateWrite) {
      // A node-scoped row is kept only while its node is: a delete that
      // committed before this transaction leaves nothing to write.
      if (isNodeWrite(change) && !(yield* nodeExists(change.canvasName, change.nodeId))) return false;
      switch (change.area) {
        case "command-slot": {
          const { canvasName, slot, value } = change;
          if (value.kind === "empty") {
            yield* sql`DELETE FROM view_command_slots WHERE canvas_name = ${canvasName} AND slot = ${slot}`;
            break;
          }
          yield* sql`
            INSERT INTO view_command_slots (canvas_name, slot, kind, node_id)
            VALUES (${canvasName}, ${slot}, ${value.kind}, ${value.kind === "fixed" ? value.nodeId : null})
            ON CONFLICT (canvas_name, slot) DO UPDATE SET kind = excluded.kind, node_id = excluded.node_id`;
          yield* sql`DELETE FROM view_command_slot_members WHERE canvas_name = ${canvasName} AND slot = ${slot}`;
          if (value.kind === "group") {
            for (const [position, nodeId] of value.nodeIds.entries()) {
              yield* sql`
                INSERT INTO view_command_slot_members (canvas_name, slot, position, node_id)
                VALUES (${canvasName}, ${slot}, ${position}, ${nodeId})`;
            }
          }
          break;
        }
        case "command-extras": {
          yield* sql`DELETE FROM view_command_extras WHERE canvas_name = ${change.canvasName}`;
          for (const [groupIndex, group] of change.value.entries()) {
            for (const [position, nodeId] of group.entries()) {
              yield* sql`
                INSERT INTO view_command_extras (canvas_name, group_index, position, node_id)
                VALUES (${change.canvasName}, ${groupIndex}, ${position}, ${nodeId})`;
            }
          }
          break;
        }
        case "artifacts-filter": {
          const { canvasName, nodeId, value } = change;
          const isDefault = value.type === "all" && !value.archived && value.labels.length === 0;
          if (isDefault) {
            yield* sql`DELETE FROM view_artifacts_filters WHERE canvas_name = ${canvasName} AND node_id = ${nodeId}`;
            break;
          }
          yield* sql`
            INSERT INTO view_artifacts_filters (canvas_name, node_id, type, archived)
            VALUES (${canvasName}, ${nodeId}, ${value.type}, ${value.archived ? 1 : 0})
            ON CONFLICT (canvas_name, node_id) DO UPDATE SET type = excluded.type, archived = excluded.archived`;
          yield* sql`DELETE FROM view_artifacts_filter_labels WHERE canvas_name = ${canvasName} AND node_id = ${nodeId}`;
          for (const [position, label] of value.labels.entries()) {
            yield* sql`
              INSERT INTO view_artifacts_filter_labels (canvas_name, node_id, label, position)
              VALUES (${canvasName}, ${nodeId}, ${label}, ${position})`;
          }
          break;
        }
        case "tasks-filter":
          if (change.value === "all") {
            yield* sql`DELETE FROM view_tasks_filters WHERE canvas_name = ${change.canvasName} AND node_id = ${change.nodeId}`;
          } else {
            yield* sql`
              INSERT INTO view_tasks_filters (canvas_name, node_id, state)
              VALUES (${change.canvasName}, ${change.nodeId}, ${change.value})
              ON CONFLICT (canvas_name, node_id) DO UPDATE SET state = excluded.state`;
          }
          break;
        case "open-item":
          if (change.value === null) {
            yield* sql`DELETE FROM view_open_items WHERE canvas_name = ${change.canvasName} AND node_id = ${change.nodeId}`;
          } else {
            const item = change.value.kind === "file" ? change.value.path : change.value.id;
            yield* sql`
              INSERT INTO view_open_items (canvas_name, node_id, kind, item)
              VALUES (${change.canvasName}, ${change.nodeId}, ${change.value.kind}, ${item})
              ON CONFLICT (canvas_name, node_id) DO UPDATE SET kind = excluded.kind, item = excluded.item`;
          }
          break;
        case "expanded-folders": {
          yield* sql`DELETE FROM view_expanded_folders WHERE canvas_name = ${change.canvasName} AND node_id = ${change.nodeId}`;
          for (const [position, path] of change.value.entries()) {
            yield* sql`
              INSERT INTO view_expanded_folders (canvas_name, node_id, path, position)
              VALUES (${change.canvasName}, ${change.nodeId}, ${path}, ${position})`;
          }
          break;
        }
        case "sidebar":
          if (change.collapsed) {
            yield* sql`
              INSERT OR IGNORE INTO view_collapsed_sidebars (canvas_name, node_id)
              VALUES (${change.canvasName}, ${change.nodeId})`;
          } else {
            yield* sql`DELETE FROM view_collapsed_sidebars WHERE canvas_name = ${change.canvasName} AND node_id = ${change.nodeId}`;
          }
          break;
        case "focus-size":
          if (change.value === null) {
            yield* sql`DELETE FROM view_focus_sizes WHERE surface = ${change.surface}`;
          } else {
            yield* sql`
              INSERT INTO view_focus_sizes (surface, width, height)
              VALUES (${change.surface}, ${Math.round(change.value.width)}, ${Math.round(change.value.height)})
              ON CONFLICT (surface) DO UPDATE SET width = excluded.width, height = excluded.height`;
          }
          break;
        case "capture-inbox": {
          if (change.inbox === null) {
            yield* sql`DELETE FROM view_capture_inboxes WHERE canvas_name = ${change.canvasName}`;
            break;
          }
          // The Inbox is an Artifacts node of this canvas, never any other kind.
          const held = yield* sql<{ one: number }>`
            SELECT 1 AS one FROM artifact_boards
            WHERE canvas_name = ${change.canvasName} AND id = ${change.inbox}`;
          if (held.length === 0) return false;
          yield* sql`
            INSERT INTO view_capture_inboxes (canvas_name, node_id) VALUES (${change.canvasName}, ${change.inbox})
            ON CONFLICT (canvas_name) DO UPDATE SET node_id = excluded.node_id`;
          break;
        }
        case "capture-draft": {
          // Only the draft's columns: the shell's columns in the same row are its own.
          const draft = change.value;
          yield* sql`
            INSERT INTO view_capture_desks
              (canvas_name, draft_of, draft_node_id, draft_type, draft_text, draft_base_version, draft_at)
            VALUES (
              ${change.canvasName}, ${draft?.of ?? null}, ${draft?.node ?? null}, ${draft === null ? null : "document"},
              ${draft?.text ?? null}, ${draft?.base ?? null}, ${draft?.at ?? null}
            )
            ON CONFLICT (canvas_name) DO UPDATE SET
              draft_of = excluded.draft_of, draft_node_id = excluded.draft_node_id, draft_type = excluded.draft_type,
              draft_text = excluded.draft_text, draft_base_version = excluded.draft_base_version, draft_at = excluded.draft_at`;
          break;
        }
        case "capture-desk": {
          // Only the shell's columns: the draft's columns in the same row are the writing's.
          const desk = change.value;
          const open = desk?.open;
          yield* sql`
            INSERT INTO view_capture_desks
              (canvas_name, open_kind, open_node_id, open_artifact_id, query, focused_artifact_id, caret, scroll_writing, scroll_list)
            VALUES (
              ${change.canvasName}, ${open?.kind ?? null},
              ${open?.kind === "artifact" ? open.nodeId : null},
              ${open?.kind === "artifact" ? open.artifactId : null},
              ${desk?.query ?? null}, ${desk?.focused ?? null}, ${desk?.caret ?? null},
              ${desk?.scrollWriting ?? null}, ${desk?.scrollList ?? null}
            )
            ON CONFLICT (canvas_name) DO UPDATE SET
              open_kind = excluded.open_kind, open_node_id = excluded.open_node_id,
              open_artifact_id = excluded.open_artifact_id, query = excluded.query,
              focused_artifact_id = excluded.focused_artifact_id, caret = excluded.caret,
              scroll_writing = excluded.scroll_writing, scroll_list = excluded.scroll_list`;
          break;
        }
        case "section":
          yield* sql`
            INSERT INTO view_sections (section, open) VALUES (${change.section}, ${change.open ? 1 : 0})
            ON CONFLICT (section) DO UPDATE SET open = excluded.open`;
          break;
      }
      return true;
    }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "viewState.write"), Effect.mapError(persistence("write")));

    const removeCanvas = Effect.fn("viewState.removeCanvas")(function* (canvas: string) {
      yield* removeViewCanvas(sql, canvas);
    }, Effect.provideService(StateTransactionOperation, "viewState.removeCanvas"), Effect.mapError(persistence("removeCanvas")));

    const removeNodes = Effect.fn("viewState.removeNodes")(function* (canvas: string, ids: ReadonlyArray<string>) {
      yield* removeViewNodes(sql, canvas, ids);
    }, Effect.provideService(StateTransactionOperation, "viewState.removeNodes"), Effect.mapError(persistence("removeNodes")));

    return ViewStateRepository.of({ snapshot, write, removeCanvas, removeNodes });
  }),
);
