/**
 * Backlinks (docs/plans/0.10/03 section 3): one row per thing a mail row
 * mentions, keyed by `mentionKey` (src/shared/mention.ts). A projection of
 * `work_messages`, written in the transaction that writes the mail row and
 * rebuilt from those rows (`mention-backlinks.ts`); never read for authority.
 * `at_ms` is the message id's time, the order a thread reads in. A mail row
 * that goes takes its backlinks with it. Added by state migration 45 -> 46.
 * A step that rebuilds work_messages copies and drops the old table: an
 * ALTER TABLE RENAME would carry this foreign key onto the old one.
 */
export const WORK_MENTIONS_SQL = `
  CREATE TABLE IF NOT EXISTS work_mentions (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    mention_key TEXT NOT NULL CHECK (length(mention_key) BETWEEN 1 AND 600),
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    message_id TEXT NOT NULL CHECK (length(message_id) BETWEEN 1 AND 256),
    at_ms INTEGER NOT NULL CHECK (at_ms >= 0),
    PRIMARY KEY (canvas_name, mention_key, node_id, message_id),
    FOREIGN KEY (canvas_name, node_id, message_id)
      REFERENCES work_messages(canvas_name, node_id, message_id)
      ON DELETE CASCADE
      ON UPDATE CASCADE
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS work_mentions_newest
    ON work_mentions(canvas_name, mention_key, at_ms DESC, message_id DESC, node_id DESC);

  CREATE INDEX IF NOT EXISTS work_mentions_row
    ON work_mentions(canvas_name, node_id, message_id);
`;
