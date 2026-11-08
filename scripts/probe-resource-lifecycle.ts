/**
 * Own one asynchronously acquired probe resource through cancellation.
 *
 * Probe runners install signal handling before all startup checks finish. A
 * shutdown can therefore arrive before, during, or after acquisition. The
 * lifecycle latches shutdown, refuses later starts, joins an in-flight start,
 * and closes the exact resource that start minted.
 */

export interface ProbeCloseableResource {
  readonly close: () => Promise<void>;
}

export interface ProbeResourceLifecycle<T extends ProbeCloseableResource> {
  readonly acquire: (start: () => Promise<T>) => Promise<T>;
  readonly close: () => Promise<boolean>;
}

export const createProbeResourceLifecycle = <T extends ProbeCloseableResource>(
  label: string,
  onCloseFailure?: (error: unknown) => void,
): ProbeResourceLifecycle<T> => {
  let resource: T | undefined;
  let acquisition: Promise<T> | undefined;
  let closeFlight: Promise<boolean> | undefined;
  let shutdownRequested = false;

  const acquire = (start: () => Promise<T>): Promise<T> => {
    if (shutdownRequested) {
      return Promise.reject(
        new Error(`${label} acquisition refused after shutdown began`),
      );
    }
    if (resource !== undefined || acquisition !== undefined) {
      return Promise.reject(new Error(`${label} acquisition already started`));
    }

    let flight!: Promise<T>;
    flight = (async () => {
      try {
        const acquired = await start();
        // Publish the exact close capability even when shutdown won while the
        // factory was awaiting. close() joins this flight and then consumes it.
        resource = acquired;
        if (shutdownRequested) {
          throw new Error(`${label} acquisition canceled by shutdown`);
        }
        return acquired;
      } finally {
        if (acquisition === flight) acquisition = undefined;
      }
    })();
    acquisition = flight;
    return flight;
  };

  const close = (): Promise<boolean> => {
    shutdownRequested = true;
    if (closeFlight !== undefined) return closeFlight;

    const flight = (async (): Promise<boolean> => {
      const pending = acquisition;
      if (pending !== undefined) {
        await pending.catch(() => undefined);
      }
      const active = resource;
      resource = undefined;
      if (active === undefined) return true;
      try {
        await active.close();
        return true;
      } catch (error) {
        onCloseFailure?.(error);
        return false;
      }
    })();
    closeFlight = flight;
    return flight;
  };

  return Object.freeze({ acquire, close });
};
