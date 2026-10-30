/**
 * View state (0.11, 04): how the operator arranged Junto, kept across a quit.
 * Machine-local, so it is not a fact, never crosses, and is not in a canvas
 * copy. One table per kind, typed columns with CHECKs, a row per thing:
 *
 * - the hotbar: one row per held slot (an absent slot is empty), its group's
 *   members by position, and the groups past nine by (group, position);
 * - a node's Artifacts filter and its picked labels; its Tasks filter; the
 *   item it had open; the folders its tree expanded; whether its sidebar is
 *   collapsed (presence is collapsed);
 * - a resized surface's size, and a named section's open flag: machine-wide,
 *   since neither belongs to a canvas.
 *
 * Every canvas-scoped table takes its canvas's delete with it. Node-scoped
 * rows are removed by the model delete seam in `model-dependents.ts`, since
 * nodes live in one of many kind tables and no single foreign key names one.
 * A node the operator never touched writes no row. Added by state migration
 * 54 -> 55; the capture Inbox (below the main block) by 64 -> 65.
 */
export const VIEW_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS view_command_slots (
    canvas_name TEXT NOT NULL
      CHECK (length(canvas_name) BETWEEN 1 AND 256)
      REFERENCES canvases (canvas_name) ON DELETE CASCADE,
    slot INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 8),
    kind TEXT NOT NULL CHECK (kind IN ('fixed', 'group')),
    node_id TEXT CHECK (node_id IS NULL OR length(node_id) BETWEEN 1 AND 256),
    PRIMARY KEY (canvas_name, slot),
    CHECK ((kind = 'fixed') = (node_id IS NOT NULL))
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS view_command_slot_members (
    canvas_name TEXT NOT NULL,
    slot INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 8),
    position INTEGER NOT NULL CHECK (position >= 0),
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    PRIMARY KEY (canvas_name, slot, position),
    FOREIGN KEY (canvas_name, slot)
      REFERENCES view_command_slots (canvas_name, slot) ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS view_command_extras (
    canvas_name TEXT NOT NULL
      CHECK (length(canvas_name) BETWEEN 1 AND 256)
      REFERENCES canvases (canvas_name) ON DELETE CASCADE,
    group_index INTEGER NOT NULL CHECK (group_index >= 0),
    position INTEGER NOT NULL CHECK (position >= 0),
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    PRIMARY KEY (canvas_name, group_index, position)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS view_artifacts_filters (
    canvas_name TEXT NOT NULL
      CHECK (length(canvas_name) BETWEEN 1 AND 256)
      REFERENCES canvases (canvas_name) ON DELETE CASCADE,
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    type TEXT NOT NULL
      CHECK (type IN ('all', 'link', 'document', 'pad', 'sheet', 'file')),
    archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
    PRIMARY KEY (canvas_name, node_id)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS view_artifacts_filter_labels (
    canvas_name TEXT NOT NULL,
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 40),
    position INTEGER NOT NULL CHECK (position >= 0),
    PRIMARY KEY (canvas_name, node_id, label),
    UNIQUE (canvas_name, node_id, position),
    FOREIGN KEY (canvas_name, node_id)
      REFERENCES view_artifacts_filters (canvas_name, node_id) ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS view_tasks_filters (
    canvas_name TEXT NOT NULL
      CHECK (length(canvas_name) BETWEEN 1 AND 256)
      REFERENCES canvases (canvas_name) ON DELETE CASCADE,
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    state TEXT NOT NULL CHECK (state IN ('open', 'backlog', 'closed', 'all')),
    PRIMARY KEY (canvas_name, node_id)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS view_open_items (
    canvas_name TEXT NOT NULL
      CHECK (length(canvas_name) BETWEEN 1 AND 256)
      REFERENCES canvases (canvas_name) ON DELETE CASCADE,
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    kind TEXT NOT NULL CHECK (kind IN ('artifact', 'task', 'automation', 'file')),
    item TEXT NOT NULL CHECK (length(item) BETWEEN 1 AND 4096),
    PRIMARY KEY (canvas_name, node_id)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS view_expanded_folders (
    canvas_name TEXT NOT NULL
      CHECK (length(canvas_name) BETWEEN 1 AND 256)
      REFERENCES canvases (canvas_name) ON DELETE CASCADE,
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 4096),
    position INTEGER NOT NULL CHECK (position >= 0),
    PRIMARY KEY (canvas_name, node_id, path),
    UNIQUE (canvas_name, node_id, position)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS view_collapsed_sidebars (
    canvas_name TEXT NOT NULL
      CHECK (length(canvas_name) BETWEEN 1 AND 256)
      REFERENCES canvases (canvas_name) ON DELETE CASCADE,
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    PRIMARY KEY (canvas_name, node_id)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS view_focus_sizes (
    surface TEXT NOT NULL CHECK (length(surface) BETWEEN 1 AND 256),
    width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 20000),
    height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 20000),
    PRIMARY KEY (surface)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS view_sections (
    section TEXT NOT NULL CHECK (length(section) BETWEEN 1 AND 128),
    open INTEGER NOT NULL CHECK (open IN (0, 1)),
    PRIMARY KEY (section)
  ) STRICT, WITHOUT ROWID;
`;

/**
 * Quick capture's Inbox (0.11.2, 11 Q4): the one Artifacts node of a canvas
 * the operator's captures land in. Machine-local like the rest of view state.
 * A row per canvas; it goes with the canvas (FK) and with its node (the model
 * delete seam, `remove.ts`). Added by state migration 64 -> 65.
 */
export const VIEW_CAPTURE_INBOX_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS view_capture_inboxes (
    canvas_name TEXT NOT NULL
      CHECK (length(canvas_name) BETWEEN 1 AND 256)
      REFERENCES canvases (canvas_name) ON DELETE CASCADE,
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    PRIMARY KEY (canvas_name)
  ) STRICT, WITHOUT ROWID;
`;

/**
 * Quick capture's desk (0.12, the Cmd+T triage desk): one row per canvas,
 * held across closing the surface, quitting and a reboot. Two owners, one
 * row: the draft columns are the words not yet in an artifact (the writing,
 * product-documents), written on every change; the open, query, focused,
 * caret and scroll columns are where the operator was (the shell,
 * product-modals), and never hold text from the writing. A draft outlives
 * its node: the words are kept even when the Inbox they were meant for
 * goes, so the row goes only with its canvas (FK). Added by state migration
 * 68 -> 69.
 */
export const VIEW_CAPTURE_DESK_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS view_capture_desks (
    canvas_name TEXT NOT NULL
      CHECK (length(canvas_name) BETWEEN 1 AND 256)
      REFERENCES canvases (canvas_name) ON DELETE CASCADE,
    draft_of TEXT CHECK (draft_of IS NULL OR length(draft_of) BETWEEN 1 AND 256),
    draft_node_id TEXT CHECK (draft_node_id IS NULL OR length(draft_node_id) BETWEEN 1 AND 256),
    draft_type TEXT CHECK (draft_type IS NULL OR draft_type IN ('document', 'pad', 'sheet')),
    draft_text TEXT CHECK (draft_text IS NULL OR length(draft_text) <= 512000),
    draft_base_version INTEGER CHECK (draft_base_version IS NULL OR draft_base_version >= 0),
    draft_at INTEGER CHECK (draft_at IS NULL OR draft_at >= 0),
    open_kind TEXT CHECK (open_kind IS NULL OR open_kind IN ('new', 'artifact')),
    open_node_id TEXT CHECK (open_node_id IS NULL OR length(open_node_id) BETWEEN 1 AND 256),
    open_artifact_id TEXT CHECK (open_artifact_id IS NULL OR length(open_artifact_id) BETWEEN 1 AND 256),
    query TEXT CHECK (query IS NULL OR length(query) <= 1024),
    focused_artifact_id TEXT CHECK (focused_artifact_id IS NULL OR length(focused_artifact_id) BETWEEN 1 AND 256),
    caret INTEGER CHECK (caret IS NULL OR caret >= 0),
    scroll_writing INTEGER CHECK (scroll_writing IS NULL OR scroll_writing >= 0),
    scroll_list INTEGER CHECK (scroll_list IS NULL OR scroll_list >= 0),
    PRIMARY KEY (canvas_name)
  ) STRICT, WITHOUT ROWID;
`;

/** The node-scoped tables the model delete seam clears, by node and canvas. */
export const VIEW_STATE_NODE_TABLES = [
  "view_artifacts_filters",
  "view_tasks_filters",
  "view_open_items",
  "view_expanded_folders",
  "view_collapsed_sidebars",
  "view_capture_inboxes",
] as const;

/** Every view-state table, for the canvas delete and its tests. */
export const VIEW_STATE_TABLES = [
  "view_command_slots",
  "view_command_slot_members",
  "view_command_extras",
  "view_artifacts_filters",
  "view_artifacts_filter_labels",
  "view_tasks_filters",
  "view_open_items",
  "view_expanded_folders",
  "view_collapsed_sidebars",
  "view_focus_sizes",
  "view_sections",
  "view_capture_inboxes",
  "view_capture_desks",
] as const;
