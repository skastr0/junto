export type CanvasBootAction =
  | { readonly kind: "open"; readonly name: string }
  | { readonly kind: "seed" };

/**
 * What the window shows first: the first canvas this machine holds, its own
 * or a copy of one another machine edits. With none, it starts an empty one.
 */
export const nextCanvasBootAction = (
  names: ReadonlyArray<string>,
): CanvasBootAction => {
  const first = names[0];
  return first === undefined ? { kind: "seed" } : { kind: "open", name: first };
};

/** A step still running this long is named in the log as stalled. */
export const BOOT_STEP_STALL_MS = 10_000;

/**
 * Run one step of the window's boot and log it under the `boot` area of
 * app.jsonl: when it starts, when it ends, and a warning if it is still
 * running after BOOT_STEP_STALL_MS. A window stuck on "opening station"
 * then names the step it is waiting on.
 */
export const bootStep = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
  const started = performance.now();
  console.info(`[boot] ${name} started at ${Math.round(started)} ms`);
  const stall = setTimeout(() => {
    console.warn(`[boot] ${name} still running after ${BOOT_STEP_STALL_MS} ms`);
  }, BOOT_STEP_STALL_MS);
  try {
    return await run();
  } finally {
    clearTimeout(stall);
    console.info(`[boot] ${name} ended after ${Math.round(performance.now() - started)} ms`);
  }
};
