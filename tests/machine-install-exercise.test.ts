import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { MachineInstallResult } from "../src/shared/machine-install";
import { InstallationId } from "../src/shared/installation-id";
import { assertLinkedStatus } from "../scripts/machine-link-exercise";
import {
  assertInstallObservation,
  assertOrderedUpdate,
  assertUnchangedResend,
  type InstallObservation,
} from "../scripts/machine-install-exercise";

const first = Schema.decodeUnknownSync(MachineInstallResult)({
  build: "a".repeat(64), juntoHome: "/home/test/run/home", installRoot: "/home/test/run/install",
  directory: `/home/test/run/install/builds/${"a".repeat(64)}-darwin-arm64`,
  serviceLabel: "dev.junto.machine.exercise", provider: "launchd", updated: true,
  disposition: "ready", installationId: "install-test", machineName: "mini", pid: 71,
  transitions: [],
});
const observation = (result: MachineInstallResult, startKey: string): InstallObservation => ({
  status: { build: result.build, form: "mac-mini", installationId: result.installationId, machineName: result.machineName,
    juntoHome: result.juntoHome, pid: result.pid, ready: true },
  epoch: { pid: result.pid, startKey },
  selected: result.directory.slice(result.installRoot.length + 1),
});
const before = observation(first, "Fri Oct  9 11:00:00 2026");
const resend: MachineInstallResult = { ...first, updated: false,
  transitions: [{ step: "verified", build: first.build }, { step: "ready", pid: first.pid }] };
const update: MachineInstallResult = {
  ...first, build: "b".repeat(64), pid: 72,
  directory: `/home/test/run/install/builds/${"b".repeat(64)}-darwin-arm64`,
  transitions: [
    { step: "verified", build: "b".repeat(64) },
    { step: "quiescent", build: first.build, pid: first.pid, startKey: before.epoch.startKey, service: "unloaded" },
    { step: "selected", build: "b".repeat(64) },
    { step: "started" },
    { step: "ready", pid: 72 },
  ],
};
const after = observation(update, "Fri Oct  9 11:01:00 2026");

describe("installer exercise evidence", () => {
  it("requires reachable status from the distinct installed peer on the same build", () => {
    const own = { ...before.status, machineName: "opener", installationId: Schema.decodeUnknownSync(InstallationId)("install-opener") };
    const peer = { machineName: first.machineName, installationId: first.installationId,
      reachable: true, form: "mac-mini" as const, harnesses: [], missingSecrets: [] };
    expect(() => assertLinkedStatus(own, first, peer)).not.toThrow();
    expect(() => assertLinkedStatus(own, first, { ...peer, reachable: false })).toThrow("linked status");
    expect(() => assertLinkedStatus(own, first, { ...peer, installationId: Schema.decodeUnknownSync(InstallationId)("install-another") })).toThrow("linked status");
    expect(() => assertLinkedStatus(own, first, { ...peer, machineName: "another" })).toThrow("linked status");
    expect(() => assertLinkedStatus(before.status, first, peer)).toThrow("distinct");
    expect(() => assertLinkedStatus({ ...own, build: "c".repeat(64) }, first, peer)).toThrow("same build");
  });

  it("accepts unchanged resend and an update joined to independently observed epochs", () => {
    expect(() => assertUnchangedResend(first, before, resend, before)).not.toThrow();
    expect(() => assertOrderedUpdate(first, before, update, after)).not.toThrow();
  });

  it("does not treat a final ready status as proof of stop ordering", () => {
    expect(() => assertOrderedUpdate(first, before, { ...update, transitions: [] }, after)).toThrow("ordered");
    const reordered = [...update.transitions];
    [reordered[1], reordered[2]] = [reordered[2]!, reordered[1]!];
    expect(() => assertOrderedUpdate(first, before, { ...update, transitions: reordered }, after)).toThrow("ordered");
  });

  it.each([
    { pid: 99 }, { startKey: "another process epoch" }, { build: "c".repeat(64) }, { service: "absent" as const },
  ])("refuses quiescence attributed to something other than the incumbent: %j", changed => {
    const transitions = update.transitions.map((row, index) => index === 1 ? { ...row, ...changed } : row);
    expect(() => assertOrderedUpdate(first, before, { ...update, transitions }, after)).toThrow("quiescence");
  });

  it("detects a resend restart even when the numeric PID was reused", () => {
    expect(() => assertUnchangedResend(first, before, resend,
      { ...before, epoch: { ...before.epoch, startKey: "Fri Oct  9 11:00:01 2026" } })).toThrow("restarted");
  });

  it("refuses independent status from another home or a core that is not ready", () => {
    expect(() => assertInstallObservation(first, { ...before, status: { ...before.status, juntoHome: "/home/other" } })).toThrow("juntoHome");
    expect(() => assertInstallObservation(first, { ...before, status: { ...before.status, ready: false } })).toThrow("ready");
  });

  it("refuses a selection or reported identity changed between installer and observation", () => {
    expect(() => assertInstallObservation(first, { ...before, selected: "builds/other" })).toThrow("selection");
    expect(() => assertInstallObservation(first, { ...before, status: { ...before.status, pid: 99 } })).toThrow("pid");
  });
});
