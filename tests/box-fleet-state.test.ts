import { beforeEach, describe, expect, it } from "vitest";
import type {
  BoxAvailabilityResult,
  BoxFleetResource,
} from "../src/shared/ipc";
import {
  boxAvailabilityNeedsRefresh,
  boxFleet$,
  cacheBoxAvailability,
  cacheOwnedBoxes,
  clearBoxFleetCache,
  invalidateBoxAvailability,
  invalidateOwnedBoxes,
  ownedBoxesNeedRefresh,
  upsertCachedBox,
} from "../src/renderer/lib/box-fleet-state";

const availability: BoxAvailabilityResult = {
  ok: true,
  available: true,
  authenticated: true,
  healthy: true,
  executable: "/Users/operator/.ascii/bin/box",
  version: "0.1.135-ascii-prod1",
  detail: "Box CLI is authenticated",
};

const box = (
  state: string,
  ip = "203.0.113.8",
): BoxFleetResource => ({
  boxId: "bx_c79mgja6",
  hostId: "box-c79mgja6",
  name: "Vellum Command Box",
  ip,
  state,
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:01:00.000Z",
  enrolledAt: "2026-07-29T00:01:00.000Z",
});

beforeEach(() => {
  clearBoxFleetCache();
});

describe("Box Fleet renderer cache", () => {
  it("reuses successful provider and ownership projections across panel mounts", () => {
    cacheBoxAvailability(availability);
    cacheOwnedBoxes([box("ready")]);

    expect(boxAvailabilityNeedsRefresh()).toBe(false);
    expect(ownedBoxesNeedRefresh()).toBe(false);
    expect(boxFleet$.availability.peek()).toEqual(availability);
    expect(boxFleet$.boxes.peek()).toEqual([box("ready")]);
  });

  it("invalidates failed slices without discarding last-known data", () => {
    cacheBoxAvailability(availability);
    cacheOwnedBoxes([box("ready")]);

    invalidateBoxAvailability();
    invalidateOwnedBoxes();

    expect(boxAvailabilityNeedsRefresh()).toBe(true);
    expect(ownedBoxesNeedRefresh()).toBe(true);
    expect(boxFleet$.availability.peek()).toEqual(availability);
    expect(boxFleet$.boxes.peek()).toEqual([box("ready")]);
  });

  it("updates one lifecycle receipt without reloading the owned inventory", () => {
    cacheOwnedBoxes([box("stopped", "203.0.113.8")]);

    upsertCachedBox(box("ready", "203.0.113.99"));

    expect(ownedBoxesNeedRefresh()).toBe(false);
    expect(boxFleet$.boxes.peek()).toEqual([
      box("ready", "203.0.113.99"),
    ]);
  });

  it("adds a newly created owned Box directly to the cached inventory", () => {
    cacheOwnedBoxes([]);

    upsertCachedBox(box("ready"));

    expect(boxFleet$.boxes.peek()).toEqual([box("ready")]);
  });
});
