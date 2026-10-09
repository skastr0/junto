/**
 * What the Machines window says about one machine. Every state the operator
 * can meet is a case here: what the row says, what it tells them to do, and
 * which actions it offers.
 */
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { MachineListData, MachineOwnStatus, MachinePeerStatus } from "../src/shared/machine-control";
import {
  harnessesSeatsLack,
  machineActions,
  machineCondition,
  machineFigureState,
  machineForm,
  machineHarnesses,
  machineMissingSecrets,
  machineSummary,
  machinesNeedingAttention,
  withInstallStep,
  type MachineCopy,
  type MachineListItem,
  type MachineRead,
} from "../src/renderer/lib/machines-view";
import { OTHER_MACHINE, THIS_MACHINE } from "./support/machines";

const BUILD = "a".repeat(64);

const listed = (more: Record<string, unknown> = {}, machine: Record<string, unknown> = {}): MachineListItem =>
  Schema.decodeUnknownSync(MachineListData)({
    machines: [
      {
        machine: { id: OTHER_MACHINE, label: "Atlas", isThisMachine: false, capabilities: ["terminal"], sshEndpoint: "op@atlas", ...machine },
        setUp: true,
        needsUpdate: false,
        // A machine that is not set up has no installation bound to its name yet.
        ...(more.setUp === false ? {} : { installationId: "inst-atlas" }),
        ...more,
      },
    ],
  }).machines[0]!;

const own = (): MachineRead => ({
  kind: "own",
  status: Schema.decodeUnknownSync(MachineOwnStatus)({
    build: BUILD, form: "macbook", installationId: "inst-studio", machineName: THIS_MACHINE, juntoHome: "/Users/op/.junto", pid: 41, ready: true,
  }),
  harnesses: [{ harness: "claude", installed: true }, { harness: "codex", installed: false }],
});

const peer = (more: Record<string, unknown> = {}): MachineRead => ({
  kind: "peer",
  status: Schema.decodeUnknownSync(MachinePeerStatus)({
    machineName: OTHER_MACHINE,
    reachable: true,
    harnesses: [{ harness: "claude", installed: true }, { harness: "codex", installed: false }],
    missingSecrets: [],
    ...more,
  }),
});

const thisMachine = listed({ installationId: "inst-studio" }, { id: THIS_MACHINE, label: "Studio", isThisMachine: true });
const NOTHING = { seats: 0, harnesses: [] };

describe("the state a machine is in", () => {
  it("is this machine, whatever else is true of it", () => {
    expect(machineCondition(thisMachine, own(), undefined)).toBe("this-machine");
    expect(machineCondition(thisMachine, undefined, undefined)).toBe("this-machine");
  });

  it("is added and not set up until Junto has been sent", () => {
    const item = listed({ setUp: false });
    expect(item.installationId).toBeUndefined();
    expect(machineCondition(item, undefined, undefined)).toBe("not-set-up");
    expect(machineSummary(item, undefined, undefined)).toEqual({
      headline: "Added. Junto is not on it yet.",
      advice: "Send Junto to set it up.",
    });
    expect(machineActions("not-set-up")).toEqual(["send", "remove"]);
  });

  it("is sending or updating while the copy runs, with nothing to press", () => {
    const sending: MachineCopy = { kind: "running", op: "send", id: "window-1", steps: ["verified"] };
    const updating: MachineCopy = { kind: "running", op: "update", id: "window-2", steps: [] };
    expect(machineCondition(listed({ setUp: false }), undefined, sending)).toBe("sending");
    expect(machineCondition(listed(), peer(), updating)).toBe("updating");
    expect(machineActions("sending")).toEqual([]);
    expect(machineActions("updating")).toEqual([]);
  });

  it("says why a send failed in the owner's own words, and offers it again", () => {
    const failed: MachineCopy = { kind: "failed", op: "send", message: "This Junto has no build for a Linux machine", steps: ["verified"] };
    const item = listed({ setUp: false });
    expect(machineCondition(item, undefined, failed)).toBe("send-failed");
    expect(machineSummary(item, undefined, failed)).toEqual({
      headline: "Junto could not be sent",
      advice: "This Junto has no build for a Linux machine",
    });
    expect(machineActions("send-failed")).toEqual(["send", "remove"]);
    expect(machineCondition(listed(), peer(), { ...failed, op: "update" })).toBe("update-failed");
  });

  it("needs an update when it runs another build, before anything is read from it", () => {
    const item = listed({ needsUpdate: true });
    expect(machineCondition(item, undefined, undefined)).toBe("needs-update");
    expect(machineCondition(item, peer({ reachable: false }), undefined)).toBe("needs-update");
    expect(machineSummary(item, undefined, undefined).headline).toBe("Runs a different build of Junto");
    expect(machineActions("needs-update")).toEqual(["update", "remove"]);
  });

  it("is checking until the machine has answered", () => {
    expect(machineCondition(listed(), undefined, undefined)).toBe("checking");
    expect(machineCondition(listed(), { kind: "reading" }, undefined)).toBe("checking");
  });

  it("cannot be reached, with the machine's own reason when it gave one", () => {
    const silent = peer({ reachable: false, harnesses: [] });
    expect(machineCondition(listed(), silent, undefined)).toBe("unreachable");
    expect(machineSummary(listed(), silent, undefined)).toEqual({
      headline: "Cannot reach this machine",
      advice: "Check that it is on and that SSH reaches it.",
    });
    const said = peer({ reachable: false, harnesses: [], detail: "SSH refused the connection" });
    expect(machineSummary(listed(), said, undefined).advice).toBe("SSH refused the connection");
    expect(machineActions("unreachable")).toEqual(["check", "update", "remove"]);
  });

  it("could not be checked when the command itself was refused", () => {
    const failed: MachineRead = { kind: "failed", message: "machine status does not match its setup binding" };
    expect(machineCondition(listed(), failed, undefined)).toBe("check-failed");
    expect(machineSummary(listed(), failed, undefined).advice).toBe("machine status does not match its setup binding");
  });

  it("is ready once it has answered", () => {
    expect(machineCondition(listed(), peer(), undefined)).toBe("ready");
    expect(machineSummary(listed(), peer(), undefined)).toEqual({ headline: "Ready" });
    expect(machineActions("ready")).toEqual(["check", "remove"]);
  });

  it("never offers to remove this machine", () => {
    expect(machineActions("this-machine")).not.toContain("remove");
  });
});

describe("the steps of a send", () => {
  it("join in the order they happen, once each", () => {
    expect(withInstallStep([], "verified")).toEqual(["verified"]);
    expect(withInstallStep(["verified"], "verified")).toEqual(["verified"]);
    expect(withInstallStep(["verified", "started"], "quiescent")).toEqual(["verified", "quiescent", "started"]);
  });
});

describe("what a machine has and lacks", () => {
  it("reports harnesses only from a machine that answered", () => {
    expect(machineHarnesses(own())?.map((row) => row.harness)).toEqual(["claude", "codex"]);
    expect(machineHarnesses(peer())?.length).toBe(2);
    expect(machineHarnesses(peer({ reachable: false, harnesses: [] }))).toBeUndefined();
    expect(machineHarnesses(undefined)).toBeUndefined();
  });

  it("names the harnesses seats placed there need and it does not have", () => {
    expect(harnessesSeatsLack(peer(), ["claude", "codex", "codex", "grok"])).toEqual(["codex", "grok"]);
    expect(harnessesSeatsLack(peer(), ["claude"])).toEqual([]);
    // Nothing is said to be lacking on a machine that has not answered.
    expect(harnessesSeatsLack(undefined, ["codex"])).toEqual([]);
  });

  it("names missing secrets and never carries a value", () => {
    const read = peer({ missingSecrets: ["ANTHROPIC_API_KEY", "GH_TOKEN"] });
    expect(machineMissingSecrets(read)).toEqual(["ANTHROPIC_API_KEY", "GH_TOKEN"]);
    expect(machineMissingSecrets(own())).toEqual([]);
  });
});

describe("what the figure is given", () => {
  it("is a blank print for a machine that is not set up", () => {
    expect(machineFigureState(listed({ setUp: false }), undefined, undefined, NOTHING)).toMatchObject({
      setUp: false, reach: "unknown", install: "idle", missingHarness: false, missingSecrets: 0, seats: 0,
    });
  });

  it("counts the steps of a send in flight", () => {
    const copy: MachineCopy = { kind: "running", op: "send", id: "window-1", steps: ["verified", "quiescent"] };
    expect(machineFigureState(listed({ setUp: false }), undefined, copy, NOTHING)).toMatchObject({ install: "sending", step: 2 });
  });

  it("takes counts and flags from a machine that answered, never a name", () => {
    const read = peer({ missingSecrets: ["ANTHROPIC_API_KEY", "GH_TOKEN"] });
    const state = machineFigureState(listed(), read, undefined, { seats: 3, harnesses: ["claude", "codex"] });
    expect(state).toEqual({ setUp: true, reach: "reachable", install: "idle", missingHarness: true, missingSecrets: 2, seats: 3 });
    expect(JSON.stringify(state)).not.toContain("ANTHROPIC");
  });

  it("marks a machine that needs an update or cannot be reached", () => {
    expect(machineFigureState(listed({ needsUpdate: true }), undefined, undefined, NOTHING).install).toBe("needs-update");
    expect(machineFigureState(listed(), peer({ reachable: false, harnesses: [] }), undefined, NOTHING).reach).toBe("unreachable");
  });

  it("draws the form the machine reported about itself", () => {
    expect(machineForm(thisMachine, own())).toBe("macbook");
    expect(machineForm(listed(), peer({ form: "mac-mini" }))).toBe("mac-mini");
  });
});

describe("how many machines want the operator", () => {
  it("counts the ones with something to do, not the ones in flight or fine", () => {
    expect(machinesNeedingAttention(["this-machine", "ready", "checking", "sending"])).toBe(0);
    expect(machinesNeedingAttention(["not-set-up", "needs-update", "unreachable", "send-failed", "ready"])).toBe(4);
  });
});
