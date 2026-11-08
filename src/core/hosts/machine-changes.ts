/**
 * Anything that may change what `machine.list` answers says so here: a
 * machine added, set up, renamed, sent, updated or removed, and a link
 * learning a peer's build. The companion follows it to push `machines.changed`.
 * In process only; nothing is stored.
 */

const listeners = new Set<() => void>();

export const onMachinesChanged = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const noteMachinesChanged = (): void => {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A listener's failure never reaches the machine operation that noted it.
    }
  }
};
