/**
 * The ids a resource write names, branded so a bare string or number never
 * stands in for one. Each is minted only through its schema: `OpId.make`,
 * `ItemId.make` and `TaskNumber.make` check the shape, and the decoders refuse
 * anything else. Effect only, so the CLI, main and the phone share it.
 */
import { Schema } from "effect";
import { ULID_PATTERN as ULID } from "./ulid";

/** What a ULID is, said in a refusal instead of the string that failed. */
export const ULID_SHAPE = "26 characters of Crockford base32 (a ULID)";

/**
 * One resource write, as the CLI process minted it: a bare ULID, never
 * prefixed. The ruler keys its ruling by (writer installation, opId), so a
 * retry that resends the same opId gets the first ruling and writes nothing.
 */
export const OpId = Schema.String.check(Schema.isPattern(ULID)).pipe(Schema.brand("OpId"));
export type OpId = typeof OpId.Type;

/**
 * An item inside a node: a task on a board, an artifact in an Artifacts node.
 * A ULID minted by whoever creates it (the caller, on a create) and kept by
 * the ruling.
 */
export const ItemId = Schema.String.check(Schema.isPattern(ULID)).pipe(Schema.brand("ItemId"));
export type ItemId = typeof ItemId.Type;

/** A task's short number on its canvas (`#42`), minted only by the ruler. */
export const TaskNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(Schema.brand("TaskNumber"));
export type TaskNumber = typeof TaskNumber.Type;

export const isOpId = Schema.is(OpId);
export const isItemId = Schema.is(ItemId);
export const isTaskNumber = Schema.is(TaskNumber);
