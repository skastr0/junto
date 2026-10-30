/**
 * 0.11 view state (04): how the operator arranged Junto, as `junto.db` keeps
 * it and as the renderer writes it. Machine-local: this is not a fact, it is
 * not journalled, and it never crosses to another machine or a canvas copy.
 *
 * One snapshot at window load, one small write per changed row as it changes,
 * last write wins, and a push to every window as a change lands. The tables
 * are in `src/main/junto/view-state/state-schema.ts`; the IPC in
 * `src/main/junto/view-state/ipc.ts`; the renderer's synchronous read is
 * `src/renderer/lib/view-state.ts`.
 *
 * A node's state is sparse: an absent field is its default. Only what the
 * operator arranged differs from the defaults, so a node they never touched
 * writes no row.
 */
import { Schema } from "effect";
import { ARTIFACT_MAX_DOCUMENT_LENGTH, ArtifactType } from "./artifact";
import { ArtifactLabel } from "./artifact-labels";
import { FILE_PATH_MAX, parseFilePath } from "./files";

export const VIEW_COMMAND_SLOT_COUNT = 9;

const strict = { parseOptions: { onExcessProperty: "error" as const } };

const CanvasName = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
);
const NodeText = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
);
const SurfaceLabel = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
);
const SectionKey = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
);
const FolderPath = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(FILE_PATH_MAX)),
  Schema.check(
    Schema.makeFilter((raw: string) =>
      raw.length > 0 && parseFilePath(raw) !== undefined
        ? true
        : "a path relative to the node's root, with no leading slash, .. or backslash",
    ),
  ),
);
const OpenItemId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(FILE_PATH_MAX)),
);

// ---------------------------------------------------------------------------
// Command groups (V2)
// ---------------------------------------------------------------------------

/** One saved slot: a node, a group in document order, or empty. */
export const ViewCommandSlot = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("empty") }),
  Schema.Struct({ kind: Schema.Literal("fixed"), nodeId: NodeText }),
  Schema.Struct({
    kind: Schema.Literal("group"),
    nodeIds: Schema.Array(NodeText).pipe(Schema.check(Schema.isMinLength(1))),
  }),
]);
export type ViewCommandSlot = typeof ViewCommandSlot.Type;

/** A canvas's hotbar: nine slots in digit order, then the groups past nine. */
export const ViewCommandGroups = Schema.Struct({
  slots: Schema.Array(ViewCommandSlot).pipe(
    Schema.check(
      Schema.makeFilter(
        (slots: ReadonlyArray<ViewCommandSlot>) =>
          slots.length === VIEW_COMMAND_SLOT_COUNT ||
          `a board has exactly ${VIEW_COMMAND_SLOT_COUNT} slots`,
      ),
    ),
  ),
  extras: Schema.Array(
    Schema.Array(NodeText).pipe(Schema.check(Schema.isMinLength(1))),
  ),
});
export type ViewCommandGroups = typeof ViewCommandGroups.Type;

// ---------------------------------------------------------------------------
// A node's filters, open item, tree, sidebar (V3)
// ---------------------------------------------------------------------------

/** `all` or one artifact type: the Artifacts node's type filter. */
export const ViewArtifactTypeFilter = Schema.Union([
  Schema.Literal("all"),
  ArtifactType,
]);
export type ViewArtifactTypeFilter = typeof ViewArtifactTypeFilter.Type;

/** The Artifacts node's filter: type, the labels picked in order, archived. */
export const ViewArtifactsFilter = Schema.Struct({
  type: ViewArtifactTypeFilter,
  labels: Schema.Array(ArtifactLabel).pipe(
    Schema.check(Schema.isMaxLength(20)),
    Schema.check(
      Schema.makeFilter(
        (labels: ReadonlyArray<ArtifactLabel>) =>
          new Set(labels).size === labels.length || "picked labels are unique",
      ),
    ),
  ),
  archived: Schema.Boolean,
});
export type ViewArtifactsFilter = typeof ViewArtifactsFilter.Type;

/** The Tasks node's state filter, the same four choices the pane offers. */
export const ViewTaskStateFilter = Schema.Literals([
  "open",
  "backlog",
  "closed",
  "all",
]);
export type ViewTaskStateFilter = typeof ViewTaskStateFilter.Type;

/** The item a node had open, if any. A file path is relative to its node root. */
export const ViewOpenItem = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("artifact"), id: OpenItemId }),
  Schema.Struct({ kind: Schema.Literal("task"), id: OpenItemId }),
  Schema.Struct({ kind: Schema.Literal("automation"), id: OpenItemId }),
  Schema.Struct({ kind: Schema.Literal("file"), path: OpenItemId }),
]);
export type ViewOpenItem = typeof ViewOpenItem.Type;

/** A resized modal's size: integers, because a panel is laid out in whole pixels. */
export const ViewFocusSize = Schema.Struct({
  width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20_000 })),
  height: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20_000 })),
});
export type ViewFocusSize = typeof ViewFocusSize.Type;

/** What is saved for one node; an absent field is its default. */
export const ViewNodeState = Schema.Struct({
  artifactsFilter: Schema.optionalKey(ViewArtifactsFilter),
  tasksFilter: Schema.optionalKey(ViewTaskStateFilter),
  openItem: Schema.optionalKey(ViewOpenItem),
  expandedFolders: Schema.optionalKey(
    Schema.Array(FolderPath).pipe(
      Schema.check(
        Schema.makeFilter(
          (folders: ReadonlyArray<string>) =>
            new Set(folders).size === folders.length || "folders are unique",
        ),
      ),
    ),
  ),
  /** True means the TwoPane sidebar is collapsed; false is absent, its default. */
  sidebarCollapsed: Schema.optionalKey(Schema.Literal(true)),
});
export type ViewNodeState = typeof ViewNodeState.Type;

/** The merged view a surface reads: every field, defaults filled in. */
export type ViewNode = {
  readonly artifactsFilter: ViewArtifactsFilter;
  readonly tasksFilter: ViewTaskStateFilter;
  readonly openItem: ViewOpenItem | null;
  readonly expandedFolders: ReadonlyArray<string>;
  readonly sidebarCollapsed: boolean;
};

export const DEFAULT_ARTIFACTS_FILTER: ViewArtifactsFilter = {
  type: "all",
  labels: [],
  archived: false,
};
export const DEFAULT_TASK_STATE_FILTER: ViewTaskStateFilter = "all";
export const DEFAULT_NODE_VIEW: ViewNode = {
  artifactsFilter: DEFAULT_ARTIFACTS_FILTER,
  tasksFilter: DEFAULT_TASK_STATE_FILTER,
  openItem: null,
  expandedFolders: [],
  sidebarCollapsed: false,
};

/** The node's saved state with its defaults: what a surface draws from. */
export const viewNodeOf = (
  saved: ViewNodeState | undefined,
): ViewNode =>
  saved === undefined
    ? DEFAULT_NODE_VIEW
    : {
        artifactsFilter: saved.artifactsFilter ?? DEFAULT_ARTIFACTS_FILTER,
        tasksFilter: saved.tasksFilter ?? DEFAULT_TASK_STATE_FILTER,
        openItem: saved.openItem ?? null,
        expandedFolders: saved.expandedFolders ?? [],
        sidebarCollapsed: saved.sidebarCollapsed === true,
      };

/** The snapshot a window opens with: every row this machine saved, sparse. */
/**
 * Quick capture's draft (0.12, the Cmd+T desk): the document words the
 * operator wrote that may not be in an artifact yet, kept on every change so
 * a close, a quit, a kill or a reboot loses none. `of` is the artifact they
 * belong to, null while none was made (no Inbox yet, or a refusal); `node`
 * is where that artifact was when the words were written; `base` the
 * version they were written over. `at` is when, in epoch milliseconds.
 */
export const CaptureDraft = Schema.Struct({
  of: Schema.NullOr(NodeText),
  node: Schema.NullOr(NodeText),
  text: Schema.String.pipe(Schema.check(Schema.isMaxLength(ARTIFACT_MAX_DOCUMENT_LENGTH))),
  base: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))),
  at: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
});
export type CaptureDraft = typeof CaptureDraft.Type;

export type ViewStateSnapshot = {
  /** By canvas name. A canvas with no saved board is absent. */
  readonly commandGroups: Readonly<Record<string, ViewCommandGroups>>;
  /** By canvas name, then node id; a node with nothing saved is absent. */
  readonly nodes: Readonly<
    Record<string, Readonly<Record<string, ViewNodeState>>>
  >;
  /** By surface label (FocusSurface `label`), machine-wide. */
  readonly focusSizes: Readonly<Record<string, ViewFocusSize>>;
  /** By section key (`artifact-comments`, `seat-sidebar:mail`), machine-wide. */
  readonly sections: Readonly<Record<string, boolean>>;
  /** By canvas name: the Artifacts node quick capture lands in (11 Q4). Absent until chosen. */
  readonly captureInboxes: Readonly<Record<string, string>>;
  /** By canvas name: quick capture's draft (0.12). Absent with none, and from a main that keeps none. */
  readonly captureDrafts?: Readonly<Record<string, CaptureDraft>>;
};

export const EMPTY_VIEW_STATE: ViewStateSnapshot = {
  commandGroups: {},
  nodes: {},
  focusSizes: {},
  sections: {},
  captureInboxes: {},
};

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** One changed row, as the renderer sends it and main pushes it back. */
export const ViewStateWrite = Schema.Union([
  Schema.Struct({
    area: Schema.Literal("command-slot"),
    canvasName: CanvasName,
    slot: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: VIEW_COMMAND_SLOT_COUNT - 1 })),
    value: ViewCommandSlot,
  }),
  Schema.Struct({
    area: Schema.Literal("command-extras"),
    canvasName: CanvasName,
    value: Schema.Array(
      Schema.Array(NodeText).pipe(Schema.check(Schema.isMinLength(1))),
    ),
  }),
  Schema.Struct({
    area: Schema.Literal("artifacts-filter"),
    canvasName: CanvasName,
    nodeId: NodeText,
    value: ViewArtifactsFilter,
  }),
  Schema.Struct({
    area: Schema.Literal("tasks-filter"),
    canvasName: CanvasName,
    nodeId: NodeText,
    value: ViewTaskStateFilter,
  }),
  Schema.Struct({
    area: Schema.Literal("open-item"),
    canvasName: CanvasName,
    nodeId: NodeText,
    value: Schema.NullOr(ViewOpenItem),
  }),
  Schema.Struct({
    area: Schema.Literal("expanded-folders"),
    canvasName: CanvasName,
    nodeId: NodeText,
    value: Schema.Array(FolderPath),
  }),
  Schema.Struct({
    area: Schema.Literal("sidebar"),
    canvasName: CanvasName,
    nodeId: NodeText,
    collapsed: Schema.Boolean,
  }),
  Schema.Struct({
    area: Schema.Literal("focus-size"),
    surface: SurfaceLabel,
    value: Schema.NullOr(ViewFocusSize),
  }),
  Schema.Struct({
    area: Schema.Literal("capture-inbox"),
    canvasName: CanvasName,
    /** The Artifacts node captures land in; null forgets the choice. */
    inbox: Schema.NullOr(NodeText),
  }),
  Schema.Struct({
    area: Schema.Literal("capture-draft"),
    canvasName: CanvasName,
    /** The draft as it stands; null clears it, once its words are in an artifact. */
    value: Schema.NullOr(CaptureDraft),
  }),
  Schema.Struct({
    area: Schema.Literal("section"),
    section: SectionKey,
    open: Schema.Boolean,
  }),
]).annotate(strict);
export type ViewStateWrite = typeof ViewStateWrite.Type;

export const decodeViewStateWrite = Schema.decodeUnknownResult(ViewStateWrite, {
  onExcessProperty: "error",
});

/**
 * Main tells every window to read the snapshot again after view rows went
 * with a node or canvas. Not a write: a window never sends this.
 */
export const ViewStateReload = Schema.Struct({ area: Schema.Literal("reload") });
export type ViewStateReload = typeof ViewStateReload.Type;

/** What the push channel carries: a committed row, or a reload after a delete. */
export const ViewStateEvent = Schema.Union([ViewStateWrite, ViewStateReload]);
export type ViewStateEvent = typeof ViewStateEvent.Type;

/** The canvas a write names; absent for the machine-wide rows. */
export const canvasOfWrite = (write: ViewStateWrite): string | undefined =>
  "canvasName" in write ? write.canvasName : undefined;
