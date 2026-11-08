/**
 * Managed seat starts take their synchronous process observation one at a
 * time, and the event loop runs between them. A batch of wakes otherwise
 * stacks those reads on the main thread into one stall.
 */
let tail: Promise<void> = Promise.resolve();

const nextTurn = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

export const runOnSeatStartTurn = <T>(work: () => Promise<T>): Promise<T> => {
  const turn = tail.then(nextTurn, nextTurn).then(work, work);
  tail = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
};

/** Test isolation. A turn already in flight still finishes on its own. */
export const resetSeatStartTurnForTests = (): void => {
  tail = Promise.resolve();
};
