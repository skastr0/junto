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
 * 54 -> 55.
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

/** The node-scoped tables the model delete seam clears, by node and canvas. */
export const VIEW_STATE_NODE_TABLES = [
  "view_artifacts_filters",
  "view_tasks_filters",
  "view_open_items",
  "view_expanded_folders",
  "view_collapsed_sidebars",
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
] as const;
