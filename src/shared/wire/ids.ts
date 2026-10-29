import { Schema } from "effect";

/**
 * The ids a resource write names, as the desktop and the phone read them
 * (0.11.3, the phone's artifacts): a node on the canvas, an item inside it,
 * one write, a task's number. Branded so a bare string or number never stands
 * in for one; each is minted only through its schema. A wire module, so its
 * import closure is `effect` alone; `physics/schema.ts` and `work-ids.ts`
 * re-export these, so there is one definition of each.
 */

/** A ULID: 26 characters of Crockford base32 (`ulid.ts` holds the same, effect-free). */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

/** What a ULID is, said in a refusal instead of the string that failed. */
export const ULID_SHAPE = "26 characters of Crockford base32 (a ULID)";

/** A node on a canvas. */
export const NodeId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(256)),
  Schema.brand("NodeId"),
);
export type NodeId = typeof NodeId.Type;

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

/** The ULID pattern the ids check, for a test to hold equal to `ulid.ts`'s. */
export const WIRE_ULID_PATTERN = ULID;
