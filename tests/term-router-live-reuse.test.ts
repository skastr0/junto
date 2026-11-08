import { describe, expect, it } from "vitest";
import {
  occupancyFromSummary,
  seatAdmission,
} from "../src/shared/terminal-seat-occupancy";
import type { TerminalSessionSummary } from "../src/shared/terminal";

const live = (
  overrides: Partial<TerminalSessionSummary> = {},
): TerminalSessionSummary => ({
  bindingId: "seat",
  epoch: "e1",
  hostId: "remote-a",
  status: "running",
  detached: false,
  createdAt: 0,
  ...overrides,
});

describe("remote seat admission", () => {
  it("activates a running, starting, or stopping occupant", () => {
    expect(seatAdmission(occupancyFromSummary("seat", live(), "remote"))._tag).toBe(
      "ActivateOccupiedSeat",
    );
    expect(
      seatAdmission(
        occupancyFromSummary("seat", live({ status: "starting" }), "remote"),
      )._tag,
    ).toBe("ActivateOccupiedSeat");
    expect(
      seatAdmission(
        occupancyFromSummary("seat", live({ stopping: true }), "remote"),
      )._tag,
    ).toBe("ActivateOccupiedSeat");
  });

  it("occupies only vacant seats", () => {
    expect(seatAdmission(occupancyFromSummary("seat", undefined, "remote"))._tag).toBe(
      "OccupyVacantSeat",
    );
    expect(
      seatAdmission(
        occupancyFromSummary("seat", live({ status: "exited" }), "remote"),
      )._tag,
    ).toBe("OccupyVacantSeat");
    expect(
      seatAdmission(
        occupancyFromSummary("seat", live({ status: "missing" }), "remote"),
      )._tag,
    ).toBe("OccupyVacantSeat");
  });
});
