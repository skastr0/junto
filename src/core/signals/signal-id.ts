import { monotonicFactory } from "ulid";

/**
 * A new signal's id. Signals are ordered newest first by creation time, then
 * by id, so two raised in one millisecond need ids that rise in the order they
 * were made. A plain ulid draws its random part afresh each call, which put
 * the later signal first about half the time; the monotonic factory counts up
 * within a millisecond instead.
 */
export const newSignalId: () => string = monotonicFactory();
