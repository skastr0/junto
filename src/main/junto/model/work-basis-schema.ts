import { workSchemaWithBasisTrigger } from "../work/state-schema";

export const WORK_FACT_CANVAS_BASIS_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS work_fact_authorial_basis_resolves
  BEFORE INSERT ON work_facts
  WHEN NEW.basis_kind = 'canvas' AND NOT EXISTS (
    SELECT 1 FROM canvases AS canvas
    JOIN work_events AS event
      ON event.event_home = NEW.event_home
      AND event.entity_home = NEW.entity_home
      AND event.seq = NEW.seq
    WHERE canvas.canvas_name = NEW.basis_canvas_name
      AND canvas.canvas_name = event.item_canvas_name
      AND canvas.seq = NEW.basis_canvas_seq
  )
  BEGIN
    SELECT RAISE(ABORT, 'fact basis must resolve its current canvas sequence');
  END;
`;

const base = workSchemaWithBasisTrigger(WORK_FACT_CANVAS_BASIS_TRIGGER_SQL);

const replace = (source: string, from: string, to: string): string => {
  if (!source.includes(from))
    throw new Error("canvas Work schema derivation lost its source fragment");
  return source.replace(from, to);
};

const authoredColumnsStart = base.indexOf(
  "    basis_authorial_generation TEXT",
);
const projectedColumnsStart = base.indexOf(
  "    basis_projected_generation TEXT",
  authoredColumnsStart,
);
if (authoredColumnsStart < 0 || projectedColumnsStart < 0)
  throw new Error("Work fact columns are missing");
const authoredColumns = base.slice(
  authoredColumnsStart,
  projectedColumnsStart,
);
const canvasColumns = `    basis_canvas_name TEXT,
    basis_canvas_seq INTEGER CHECK (
      basis_canvas_seq IS NULL OR basis_canvas_seq BETWEEN 0 AND 9007199254740991
    ),
`;

const authoredShapeStart = base.indexOf(
  "        basis_kind = 'authorial-intent'",
);
const authoredShapeEnd = base.indexOf(
  "      )\n      OR",
  authoredShapeStart,
);
if (authoredShapeStart < 0 || authoredShapeEnd < 0)
  throw new Error("Work fact basis check is missing");
const authoredShape = base.slice(
  authoredShapeStart,
  authoredShapeEnd,
);
const canvasShape = `        basis_kind = 'historical'
        AND basis_canvas_name IS NULL
        AND basis_canvas_seq IS NULL
        AND basis_projected_generation IS NULL
        AND basis_projected_content_sha256 IS NULL
        AND basis_command_event_home IS NULL
        AND basis_command_entity_home IS NULL
        AND basis_command_seq IS NULL
        AND basis_command_sha256 IS NULL
      )
      OR (
        basis_kind = 'canvas'
        AND basis_canvas_name IS NOT NULL
        AND basis_canvas_seq IS NOT NULL
        AND basis_projected_generation IS NULL
        AND basis_projected_content_sha256 IS NULL
        AND basis_command_event_home IS NULL
        AND basis_command_entity_home IS NULL
        AND basis_command_seq IS NULL
        AND basis_command_sha256 IS NULL
`;

/** Station storage remains inert; local facts name a canvas and logical seq. */
export const WORK_STATE_SCHEMA_CANVAS_BASIS_SQL = replace(
  replace(
    base,
    authoredColumns,
    canvasColumns,
  ),
  authoredShape,
  canvasShape,
)
  .replace("'authorial-intent',", "'canvas', 'historical',")
  .replaceAll(
    "AND basis_authorial_generation IS NULL",
    "AND basis_canvas_name IS NULL",
  )
  .replaceAll(
    "AND basis_authorial_content_sha256 IS NULL",
    "AND basis_canvas_seq IS NULL",
  );

const factTableStart = WORK_STATE_SCHEMA_CANVAS_BASIS_SQL.indexOf(
  "  CREATE TABLE IF NOT EXISTS work_facts (",
);
const factTableEnd = WORK_STATE_SCHEMA_CANVAS_BASIS_SQL.indexOf(
  ") STRICT, WITHOUT ROWID;",
  factTableStart,
);
if (factTableStart < 0 || factTableEnd < 0)
  throw new Error("Work fact table is missing");
export const WORK_FACTS_CANVAS_TABLE_SQL =
  WORK_STATE_SCHEMA_CANVAS_BASIS_SQL.slice(
    factTableStart,
    factTableEnd + ") STRICT, WITHOUT ROWID;".length,
  );
