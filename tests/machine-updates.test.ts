import { describe, expect, it } from "vitest";

import { decideMachineUpdate, type MachineUpdateFacts } from "../src/shared/machine-updates";

const ownBuild = "a".repeat(64);
const facts = (overrides: Partial<MachineUpdateFacts> = {}): MachineUpdateFacts => ({
  peerBuild: "b".repeat(64),
  ownBuild,
  peerRelease: { version: "0.10.0" },
  ownRelease: { version: "0.11.0" },
  runningSeats: 0,
  editedHere: false,
  latchedForBuild: false,
  downloadsBundles: false,
  signedRelease: false,
  ...overrides,
});

describe("automatic machine update", () => {
  it("updates an idle peer with no click", () => {
    expect(decideMachineUpdate(facts())).toEqual({ kind: "update" });
  });

  it("keeps the click while any seat runs, and when the count is unknown", () => {
    expect(decideMachineUpdate(facts({ runningSeats: 2 }))).toEqual({ kind: "click", reason: "running-seats" });
    expect(decideMachineUpdate(facts({ runningSeats: undefined }))).toEqual({ kind: "click", reason: "unknown-seats" });
  });

  it("never installs from a peer and tells the operator when this machine is behind", () => {
    expect(decideMachineUpdate(facts({ peerRelease: { version: "0.12.0" } }))).toEqual({ kind: "tell", reason: "this-older" });
  });

  it("latches one failed push per build", () => {
    expect(decideMachineUpdate(facts({ latchedForBuild: true }))).toEqual({ kind: "skip", reason: "latched" });
  });

  it("refuses a downloaded bundle without a signed release, and still allows this machine's own build", () => {
    expect(decideMachineUpdate(facts({ downloadsBundles: true, signedRelease: false }))).toEqual({ kind: "tell", reason: "needs-signed-release" });
    expect(decideMachineUpdate(facts({ downloadsBundles: true, signedRelease: true }))).toEqual({ kind: "update" });
    expect(decideMachineUpdate(facts({ downloadsBundles: false, signedRelease: false }))).toEqual({ kind: "update" });
  });

  it("never pushes to the machine that edits a canvas this one holds", () => {
    expect(decideMachineUpdate(facts({ editedHere: true }))).toEqual({ kind: "skip", reason: "editor" });
  });

  it("does nothing for a matching or unknown peer build", () => {
    expect(decideMachineUpdate(facts({ peerBuild: ownBuild }))).toEqual({ kind: "skip", reason: "same-build" });
    expect(decideMachineUpdate(facts({ peerBuild: undefined }))).toEqual({ kind: "skip", reason: "unknown-build" });
  });
});
