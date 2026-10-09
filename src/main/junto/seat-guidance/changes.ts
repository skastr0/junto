/**
 * Who hears that a seat's soul or instructions changed. The store says so
 * after every committed write, so the copy of a canvas another machine holds
 * follows what the operator wrote.
 */
type Listener = (seatId: string) => void;

const listeners = new Set<Listener>();

export const onSeatGuidanceChanged = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const emitSeatGuidanceChanged = (seatId: string): void => {
  for (const listener of [...listeners]) {
    try {
      listener(seatId);
    } catch {
      // One listener's failure is not the writer's.
    }
  }
};
