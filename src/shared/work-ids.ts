/**
 * The ids a resource write names. They are wire values
 * (`src/shared/wire/ids.ts`), so the CLI, main and the phone share one
 * definition; this path re-exports them for every existing import.
 */
export { isItemId, isOpId, isTaskNumber, ItemId, OpId, TaskNumber, ULID_SHAPE } from "./wire/ids";
