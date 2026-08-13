import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  assertDoorForMode,
  doorForMode,
  enrollVerbAdmitted,
  modeFromConfiguration,
  peerVerbAdmitted,
} from "../src/shared/station-mode";

describe("station process mode", () => {
  it("binds exactly one door per mode", () => {
    expect(doorForMode("unenrolled")).toBe("enroll");
    expect(doorForMode("remote")).toBe("peer");
    expect(doorForMode("command-center")).toBeUndefined();
  });

  it("refuses the opposite door", () => {
    expect(Result.isFailure(assertDoorForMode("unenrolled", "peer"))).toBe(true);
    expect(Result.isFailure(assertDoorForMode("remote", "enroll"))).toBe(true);
    expect(Result.isSuccess(assertDoorForMode("unenrolled", "enroll"))).toBe(
      true,
    );
    expect(Result.isSuccess(assertDoorForMode("remote", "peer"))).toBe(true);
  });

  it("derives mode from durable role", () => {
    expect(modeFromConfiguration(undefined)).toBe("unenrolled");
    expect(modeFromConfiguration("")).toBe("unenrolled");
    expect(modeFromConfiguration("remote")).toBe("remote");
    expect(modeFromConfiguration("command-center")).toBe("command-center");
  });

  it("keeps report off the enroll door", () => {
    expect(enrollVerbAdmitted("status")).toBe(true);
    expect(enrollVerbAdmitted("pair")).toBe(true);
    expect(enrollVerbAdmitted("configure")).toBe(true);
    expect(enrollVerbAdmitted("report")).toBe(false);
    expect(enrollVerbAdmitted("project")).toBe(false);
    expect(peerVerbAdmitted("report")).toBe(true);
    expect(peerVerbAdmitted("project")).toBe(true);
    expect(peerVerbAdmitted("pair")).toBe(false);
  });
});
