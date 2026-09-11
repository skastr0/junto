import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import {
  makeOwnerLocalStationControlHandoffAuthority,
  type StationControlLocalHandoff,
} from "../src/main/vellum-command/station/peer-authority";

describe("Station owner-local handoff authority", () => {
  it("binds one opaque admission to the exact accepted socket", () => {
    const authority = makeOwnerLocalStationControlHandoffAuthority();
    const accepted = new Socket();
    const other = new Socket();

    const handoff = authority.capture(accepted);

    expect(handoff).toBeDefined();
    expect(authority.capture(accepted)).toBe(handoff);
    expect(authority.isCurrent(accepted, handoff!)).toBe(true);
    expect(authority.isCurrent(other, handoff!)).toBe(false);
  });

  it("rejects reconstructed admissions", () => {
    const authority = makeOwnerLocalStationControlHandoffAuthority();
    const accepted = new Socket();
    const forged = Object.freeze({
      _tag: "StationControlLocalHandoff" as const,
    }) as StationControlLocalHandoff;

    expect(authority.isCurrent(accepted, forged)).toBe(false);
  });

  it("does not admit or retain a destroyed socket", () => {
    const authority = makeOwnerLocalStationControlHandoffAuthority();
    const accepted = new Socket();
    const handoff = authority.capture(accepted);
    accepted.destroy();

    expect(authority.capture(accepted)).toBeUndefined();
    expect(authority.isCurrent(accepted, handoff!)).toBe(false);
  });
});
