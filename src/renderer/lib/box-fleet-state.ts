import { batch, observable } from "@legendapp/state";
import type {
  BoxAvailabilityResult,
  BoxFleetResource,
} from "@shared/ipc";

/**
 * Renderer-session projection of the optional Box provider.
 *
 * Main/SQLite remain authoritative. This cache only prevents the transient
 * provider panel from forgetting its last successful projection when closed.
 * Invalidating a slice retains its last-known value while requiring the next
 * open to refresh it.
 */
export const boxFleet$ = observable({
  availability: null as BoxAvailabilityResult | null,
  boxes: [] as ReadonlyArray<BoxFleetResource>,
  availabilityValid: false,
  boxesValid: false,
});

export const cacheBoxAvailability = (
  availability: BoxAvailabilityResult,
): void => {
  batch(() => {
    boxFleet$.availability.set(availability);
    boxFleet$.availabilityValid.set(true);
  });
};

export const cacheOwnedBoxes = (
  boxes: ReadonlyArray<BoxFleetResource>,
): void => {
  batch(() => {
    boxFleet$.boxes.set([...boxes]);
    boxFleet$.boxesValid.set(true);
  });
};

export const upsertCachedBox = (box: BoxFleetResource): void => {
  const current = boxFleet$.boxes.peek();
  const index = current.findIndex((candidate) => candidate.boxId === box.boxId);
  const next =
    index === -1
      ? [...current, box]
      : current.map((candidate, candidateIndex) =>
          candidateIndex === index ? box : candidate
        );
  batch(() => {
    boxFleet$.boxes.set(next);
    boxFleet$.boxesValid.set(true);
  });
};

export const invalidateBoxAvailability = (): void => {
  boxFleet$.availabilityValid.set(false);
};

export const invalidateOwnedBoxes = (): void => {
  boxFleet$.boxesValid.set(false);
};

export const boxAvailabilityNeedsRefresh = (): boolean =>
  !boxFleet$.availabilityValid.peek();

export const ownedBoxesNeedRefresh = (): boolean =>
  !boxFleet$.boxesValid.peek();

/** Test and explicit provider-reset seam; ordinary errors retain stale data. */
export const clearBoxFleetCache = (): void => {
  batch(() => {
    boxFleet$.availability.set(null);
    boxFleet$.boxes.set([]);
    boxFleet$.availabilityValid.set(false);
    boxFleet$.boxesValid.set(false);
  });
};
