/**
 * Where the two thread keys land: Open threads and Quick thread (key table,
 * "Threads"). The key table says which chords; the surfaces that answer
 * them say what happens, by providing a run here.
 *
 * - Open threads: Global threads provides the open, from wherever it is
 *   mounted to listen.
 * - Quick thread: its canvas home provides it, and Global threads provides
 *   its own while it is open, so the key starts the new thread inside it.
 *
 * The last provider answers until it lets go, so the surface in front wins
 * and the one under it answers again when it closes. With no provider, or a
 * run that returns false, the key passes.
 */

export type ThreadKeyId = "threads.open" | "threads.quick";

/** Does what the key asks. Return false when there was nothing to do. */
export type ThreadKeyRun = () => boolean | void;

type Provider = { readonly run: ThreadKeyRun };

const providers: Record<ThreadKeyId, Provider[]> = { "threads.open": [], "threads.quick": [] };

/** Answer a thread key until the returned function is called. */
export const provideThreadKey = (id: ThreadKeyId, run: ThreadKeyRun): (() => void) => {
  const provider: Provider = { run };
  providers[id].push(provider);
  return () => {
    const list = providers[id];
    const at = list.indexOf(provider);
    if (at !== -1) list.splice(at, 1);
  };
};

/** Run the key's provider in front. False when no one answered: the key passes. */
export const runThreadKey = (id: ThreadKeyId): boolean => {
  const front = providers[id].at(-1);
  return front !== undefined && front.run() !== false;
};
