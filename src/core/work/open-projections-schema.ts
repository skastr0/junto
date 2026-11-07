/**
 * What is still open in the work log, kept beside it so a read never walks
 * the log to find it (protect the main thread, 0.11.7). Added by state
 * migration 72 -> 73.
 *
 * `open_commands` holds each `command.queued` fact whose writer homes it
 * (event home = entity home) and that no ruling for that writer, canvas,
 * node and op has answered. `open_seat_controls` holds each first
 * `seat.control` fact whose (firing, action) has no `seat_controls` row.
 *
 * Triggers keep both, so they change in the transaction of the fact or the
 * settle that changes them, whoever wrote it: every fact, local or folded
 * from a peer, is one insert of its event and then of its fact
 * (`work/journal.ts`). A trigger never refuses a fact: the columns read from
 * a fact's JSON are untyped (ANY), and nothing here is checked.
 */
export const OPEN_PROJECTIONS_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS open_commands (
    canvas_name TEXT NOT NULL,
    writer TEXT NOT NULL,
    seq TEXT NOT NULL,
    node_id TEXT NOT NULL,
    op_id TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    PRIMARY KEY (canvas_name, writer, seq)
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS open_commands_by_op
    ON open_commands(canvas_name, op_id, writer);

  CREATE TABLE IF NOT EXISTS open_seat_controls (
    canvas_name TEXT NOT NULL,
    event_home TEXT NOT NULL,
    entity_home TEXT NOT NULL,
    seq TEXT NOT NULL,
    firing_id ANY,
    action_index ANY,
    received_at TEXT NOT NULL,
    PRIMARY KEY (canvas_name, event_home, entity_home, seq)
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS open_seat_controls_by_action
    ON open_seat_controls(canvas_name, firing_id, action_index);

  CREATE INDEX IF NOT EXISTS open_seat_controls_by_arrival
    ON open_seat_controls(canvas_name, received_at);

  CREATE TRIGGER IF NOT EXISTS open_projections_follow_fact
  AFTER INSERT ON work_facts
  BEGIN
    INSERT OR IGNORE INTO open_commands(canvas_name, writer, seq, node_id, op_id, bytes)
    SELECT event.item_canvas_name, event.event_home, event.seq, event.item_node_id, event.item_id,
           length(CAST(NEW.result_json AS BLOB))
    FROM work_events AS event
    WHERE event.event_home = NEW.event_home AND event.entity_home = NEW.entity_home AND event.seq = NEW.seq
      AND event.operation = 'command.queued' AND event.event_home = event.entity_home
      AND NOT EXISTS (
        SELECT 1 FROM work_events AS ruling INDEXED BY work_events_by_item
        JOIN work_facts AS ruled USING (event_home, entity_home, seq)
        WHERE ruling.item_canvas_name = event.item_canvas_name AND ruling.item_kind = 'ruling'
          AND ruling.item_id = event.item_id AND ruling.item_node_id = event.item_node_id
          AND json_extract(ruled.result_json, '$.writer') = event.event_home
      );

    DELETE FROM open_commands
    WHERE (canvas_name, op_id, writer, node_id) IN (
      SELECT event.item_canvas_name, event.item_id, json_extract(NEW.result_json, '$.writer'), event.item_node_id
      FROM work_events AS event
      WHERE event.event_home = NEW.event_home AND event.entity_home = NEW.entity_home AND event.seq = NEW.seq
        AND event.item_kind = 'ruling'
    );

    INSERT OR IGNORE INTO open_seat_controls(canvas_name, event_home, entity_home, seq, firing_id, action_index, received_at)
    SELECT event.item_canvas_name, event.event_home, event.entity_home, event.seq,
           json_extract(NEW.result_json, '$.firingId'), json_extract(NEW.result_json, '$.actionIndex'), event.received_at
    FROM work_events AS event
    WHERE event.event_home = NEW.event_home AND event.entity_home = NEW.entity_home AND event.seq = NEW.seq
      AND event.operation = 'seat.control' AND NEW.predecessor_seq IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM seat_controls AS settled
        WHERE settled.canvas_name = event.item_canvas_name
          AND settled.firing_id = json_extract(NEW.result_json, '$.firingId')
          AND settled.action_index = json_extract(NEW.result_json, '$.actionIndex')
      );
  END;

  CREATE TRIGGER IF NOT EXISTS open_seat_controls_follow_settle
  AFTER INSERT ON seat_controls
  BEGIN
    DELETE FROM open_seat_controls
    WHERE canvas_name = NEW.canvas_name AND firing_id = NEW.firing_id AND action_index = NEW.action_index;
  END;
`;

/** The open rows of a log written before the projections, as the triggers would have kept them. */
export const OPEN_PROJECTIONS_BACKFILL_SQL = `
  INSERT OR IGNORE INTO open_commands(canvas_name, writer, seq, node_id, op_id, bytes)
  SELECT command.item_canvas_name, command.event_home, command.seq, command.item_node_id, command.item_id,
         length(CAST(fact.result_json AS BLOB))
  FROM work_events AS command
  JOIN work_facts AS fact USING (event_home, entity_home, seq)
  WHERE command.operation = 'command.queued' AND command.event_home = command.entity_home
    AND NOT EXISTS (
      SELECT 1 FROM work_events AS ruling INDEXED BY work_events_by_item
      JOIN work_facts AS ruled USING (event_home, entity_home, seq)
      WHERE ruling.item_canvas_name = command.item_canvas_name AND ruling.item_kind = 'ruling'
        AND ruling.item_id = command.item_id AND ruling.item_node_id = command.item_node_id
        AND json_extract(ruled.result_json, '$.writer') = command.event_home
    );

  INSERT OR IGNORE INTO open_seat_controls(canvas_name, event_home, entity_home, seq, firing_id, action_index, received_at)
  SELECT event.item_canvas_name, event.event_home, event.entity_home, event.seq,
         json_extract(fact.result_json, '$.firingId'), json_extract(fact.result_json, '$.actionIndex'), event.received_at
  FROM work_events AS event
  JOIN work_facts AS fact USING (event_home, entity_home, seq)
  WHERE event.operation = 'seat.control' AND fact.predecessor_seq IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM seat_controls AS settled
      WHERE settled.canvas_name = event.item_canvas_name
        AND settled.firing_id = json_extract(fact.result_json, '$.firingId')
        AND settled.action_index = json_extract(fact.result_json, '$.actionIndex')
    );
`;

/**
 * The reads the projections serve, each a search of an open table and a
 * keyed join to its fact. tests/open-projections-migration.test.ts holds each
 * equal to the log read it replaced.
 */
export const OPEN_READS = {
  /** A canvas's seat controls not yet settled, newest arrival first. Binds: canvas. */
  pendingSeatControls: `
    SELECT held.event_home AS writer, event.item_id AS control_id,
           event.origin_at, event.received_at, fact.result_json
    FROM open_seat_controls AS held INDEXED BY open_seat_controls_by_arrival
    JOIN work_events AS event USING (event_home, entity_home, seq)
    JOIN work_facts AS fact USING (event_home, entity_home, seq)
    WHERE held.canvas_name = ?
    ORDER BY held.received_at DESC`,
  /** How many commands one writer has queued and not had ruled, and their bytes. Binds: canvas, writer. */
  queueLoad: `
    SELECT count(*) AS rows, sum(bytes) AS bytes FROM open_commands
    WHERE canvas_name = ? AND writer = ?`,
  /** Every writer's unruled commands on a canvas, in each writer's order. Binds: canvas. */
  unruledCommands: `
    SELECT held.writer, fact.result_json
    FROM open_commands AS held
    JOIN work_facts AS fact ON fact.event_home = held.writer AND fact.entity_home = held.writer AND fact.seq = held.seq
    WHERE held.canvas_name = ?
    ORDER BY held.writer, length(held.seq), held.seq`,
} as const;

/**
 * One writer's open commands on a canvas, as the op reads take them: the
 * command's fact as `fact`, its op id as `held.op_id`, none this machine's
 * own ruling table has answered. Binds: canvas, writer, then `where`'s own.
 */
export const openCommandsOf = (where: string): string => `
  FROM open_commands AS held
  JOIN work_events AS event ON event.event_home = held.writer AND event.entity_home = held.writer AND event.seq = held.seq
  JOIN work_facts AS fact ON fact.event_home = held.writer AND fact.entity_home = held.writer AND fact.seq = held.seq
  WHERE held.canvas_name = ? AND held.writer = ? AND event.item_kind = 'command'
    AND NOT EXISTS (
      SELECT 1 FROM resource_rulings AS ruled
      WHERE ruled.canvas_name = held.canvas_name AND ruled.writer = held.writer AND ruled.op_id = held.op_id
    )
    -- The op reads take a ruling on any node as an answer; the open table
    -- keeps the node. One keyed search per open row keeps them equal.
    AND NOT EXISTS (
      SELECT 1 FROM work_events AS ruling INDEXED BY work_events_by_item
      JOIN work_facts AS ruled USING (event_home, entity_home, seq)
      WHERE ruling.item_canvas_name = held.canvas_name AND ruling.item_kind = 'ruling'
        AND ruling.item_id = held.op_id AND json_extract(ruled.result_json, '$.writer') = held.writer
    )
    ${where}`;
