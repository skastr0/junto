import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  activateOccupiedSeat,
  evictOccupiedSeat,
  occupancyFromSession,
  occupancyFromSummary,
  occupyVacantSeat,
  seatAdmission,
} from "../src/shared/terminal-seat-occupancy";

describe("seat occupancy", () => {
  it("is vacant when there is no generation or it has exited", () => {
    expect(occupancyFromSession("seat-a", undefined)._tag).toBe("VacantSeat");
    expect(
      occupancyFromSession("seat-a", { epoch: "e1", status: "exited" })._tag,
    ).toBe("VacantSeat");
    expect(
      occupancyFromSession("seat-a", { epoch: "e1", status: "missing" })._tag,
    ).toBe("VacantSeat");
  });

  it("is occupied while starting, running, or stopping", () => {
    expect(
      occupancyFromSession("seat-a", { epoch: "e1", status: "running" })._tag,
    ).toBe("OccupiedSeat");
    expect(
      occupancyFromSession("seat-a", { epoch: "e1", status: "starting" })._tag,
    ).toBe("OccupiedSeat");
    expect(
      occupancyFromSession("seat-a", {
        epoch: "e1",
        status: "running",
        stopping: true,
      })._tag,
    ).toBe("OccupiedSeat");
  });

  it("carries seat placement independently of process liveness", () => {
    const remote = occupancyFromSummary(
      "seat-a",
      { epoch: "e1", status: "running", hostId: "remote-a" },
      "remote",
    );
    expect(remote).toMatchObject({
      _tag: "OccupiedSeat",
      placement: "remote",
    });
    expect(occupancyFromSession("seat-a", undefined, "remote").placement).toBe(
      "remote",
    );
  });

  it("refuses occupy on an occupied seat and activate on a vacant seat", () => {
    const vacant = occupancyFromSession("seat-a", undefined);
    const occupied = occupancyFromSession("seat-a", {
      epoch: "e1",
      status: "running",
    });
    expect(Result.isSuccess(occupyVacantSeat(vacant))).toBe(true);
    expect(Result.isFailure(occupyVacantSeat(occupied))).toBe(true);
    expect(Result.isSuccess(activateOccupiedSeat(occupied))).toBe(true);
    expect(Result.isFailure(activateOccupiedSeat(vacant))).toBe(true);
    expect(Result.isSuccess(evictOccupiedSeat(occupied))).toBe(true);
    expect(Result.isFailure(evictOccupiedSeat(vacant))).toBe(true);
  });

  it("admits occupy vs activate as disjoint command families", () => {
    expect(seatAdmission(occupancyFromSession("seat-a", undefined))._tag).toBe(
      "OccupyVacantSeat",
    );
    expect(
      seatAdmission(
        occupancyFromSession("seat-a", { epoch: "e1", status: "running" }),
      )._tag,
    ).toBe("ActivateOccupiedSeat");
    expect(
      seatAdmission(
        occupancyFromSession("seat-a", {
          epoch: "e1",
          status: "running",
          stopping: true,
        }),
      )._tag,
    ).toBe("ActivateOccupiedSeat");
  });
});
