/**
 * The head of the state-schema chain, on its own so a reader that only needs
 * the number does not link the migration chain, the schema and the engine into
 * its process: the boot gate's read-only probe asks for exactly this and the
 * database path before anything opens junto.db.
 *
 * `state/migrations.ts` imports this and re-exports it, so the name still
 * reads from there, where it is documented; a schema bump edits it here.
 */
export const CURRENT_STATE_SCHEMA_VERSION = 73;
