/**
 * Anything that may change what `machine.list` answers says so here: a
 * machine added, set up, renamed, sent, updated or removed, a hello carrying
 * a peer build not heard before, and a link that had opened closing. The companion follows
 * it to push `machines.changed`, and the window's `machinesChanged`
 * (machine-pushes.ts).
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
