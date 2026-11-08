/**
 * How big a row may be, and how many rows one `rows` frame carries
 * (docs/plans/0.10/02-universal-resources.md, Contracts "Size" and "Bounded").
 *
 * A link closes on any frame over 1 MiB, so a page of rows is cut by bytes as
 * well as by count. A row a machine writes is at most 64 KiB
 * (COMMAND_ROW_MAX_BYTES, the 02 row bound, held for every row): a body larger
 * than that travels as a content ref, never inline. Rows written before the
 * cap, or by a machine without it, are still bounded by the 256 KiB record
 * bound, so any one row always fits a frame on its own.
 */
import { Schema } from "effect";
import { COMMAND_ROW_MAX_BYTES } from "./resource-command";
import { WorkFact } from "./work-protocol";

/** The largest frame a link reads or writes, without its newline. */
export const LINK_FRAME_MAX_BYTES = 1024 * 1024;

/**
 * Room for everything in a rows frame but its rows: the link event around
 * it, the canvas name and id, the writer, `through`, and the array brackets.
 * At their longest and worst escaped these come to under 3 KiB.
 */
export const EXCHANGE_ROWS_ENVELOPE_BYTES = 4 * 1024;

/** The bytes of rows one frame carries, a comma counted for each. */
export const EXCHANGE_ROWS_PAGE_BYTES = LINK_FRAME_MAX_BYTES - EXCHANGE_ROWS_ENVELOPE_BYTES;

const encodeFact = Schema.encodeSync(WorkFact);
const utf8 = new TextEncoder();

/** A row's bytes as it crosses a link: its encoded JSON. */
export const workRowBytes = (fact: WorkFact): number =>
  utf8.encode(JSON.stringify(encodeFact(fact))).byteLength;

/**
 * One page of a writer's rows, in sequence order, from the rows above a
 * cursor. A candidate without a fact is a row that does not cross; it is
 * passed over and still counts as read. A page takes rows while it holds
 * fewer than `count` and their bytes fit `bytes`, and always takes the first
 * row that crosses, which the record bound keeps inside one frame.
 *
 * `cutAt` is the last row the page read, present only when the page stopped
 * at its count or its bytes with rows left: the caller pages again from it.
 */
export const pageExchangeRows = <F extends WorkFact>(
  candidates: ReadonlyArray<{ readonly seq: string; readonly fact: F | undefined }>,
  bound: { readonly count: number; readonly bytes: number },
): { readonly taken: ReadonlyArray<F>; readonly cutAt?: string } => {
  const taken: F[] = [];
  let used = 0;
  let read: string | undefined;
  for (const { seq, fact } of candidates) {
    if (fact !== undefined) {
      const bytes = workRowBytes(fact) + 1;
      if (taken.length > 0 && (taken.length >= bound.count || used + bytes > bound.bytes)) {
        return { taken, cutAt: read! };
      }
      used += bytes;
      taken.push(fact);
    }
    read = seq;
  }
  return { taken };
};

/** A machine refused to write a row over the cap; its body belongs in a content ref. */
export class WorkRowTooLarge extends Schema.TaggedError<WorkRowTooLarge>()("WorkRowTooLarge", {
  bytes: Schema.Int,
  limit: Schema.Int,
  message: Schema.String,
}) {}

/** Refuse a row over the cap, before it is written. */
export const assertWorkRowBound = (fact: WorkFact): WorkRowTooLarge | undefined => {
  const bytes = workRowBytes(fact);
  return bytes > COMMAND_ROW_MAX_BYTES
    ? new WorkRowTooLarge({ bytes, limit: COMMAND_ROW_MAX_BYTES, message: `this write is ${bytes} bytes and one row holds at most ${COMMAND_ROW_MAX_BYTES}` })
    : undefined;
};

/** The refusal under a failure, however deep a repository wrapped it. */
export const workRowTooLargeIn = (error: unknown): WorkRowTooLarge | undefined => {
  let at: unknown = error;
  for (let depth = 0; depth < 8 && typeof at === "object" && at !== null; depth += 1) {
    if (at instanceof WorkRowTooLarge) return at;
    at = (at as { readonly cause?: unknown }).cause;
  }
  return undefined;
};
