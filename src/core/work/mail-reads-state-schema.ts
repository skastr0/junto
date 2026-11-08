/**
 * The operator's read point in each mail thread (0.11.3): one per thread of
 * a canvas, shared by the desktop and the phone, since there is one operator.
 * A thread between two seats is one conversation, so it has one point, read
 * under either seat. `through_message_id` is the newest mail read, and
 * `through_at` its time from the id; `read_at` is the Mac clock when the
 * point last moved. Machine-local, as the operator reads on this Mac.
 */
export const OPERATOR_MAIL_READS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS operator_mail_reads (
    canvas_name TEXT NOT NULL
      CHECK (length(canvas_name) BETWEEN 1 AND 256)
      REFERENCES canvases (canvas_name) ON DELETE CASCADE,
    thread_id TEXT NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 256),
    through_message_id TEXT NOT NULL CHECK (length(through_message_id) BETWEEN 1 AND 256),
    through_at INTEGER NOT NULL CHECK (through_at >= 0),
    read_at INTEGER NOT NULL CHECK (read_at >= 0),
    PRIMARY KEY (canvas_name, thread_id)
  ) STRICT, WITHOUT ROWID;
`;
