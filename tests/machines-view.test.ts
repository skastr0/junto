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
  machineNamed,
  machineStepLines,
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
      needsYou: true,
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
    // The owner said the machine was left as it was: that is what makes this a plain failure.
    const failed: MachineCopy = {
      kind: "failed", op: "send", id: "window-1", message: "This Junto has no build for a Linux machine",
      steps: ["verified"], disposition: "staged", installed: false,
    };
    const item = listed({ setUp: false });
    expect(machineCondition(item, undefined, failed)).toBe("send-failed");
    expect(machineSummary(item, undefined, failed)).toEqual({
      headline: "Junto could not be sent",
      advice: "This Junto has no build for a Linux machine",
      needsYou: true,
    });
    expect(machineActions("send-failed")).toEqual(["send", "remove"]);
    expect(machineCondition(listed(), peer(), { ...failed, op: "update" })).toBe("update-failed");
    expect(machineStepLines(failed).map((line) => line.phase)).toEqual(["done", "not-reached", "not-reached", "not-reached", "not-reached"]);
  });

  it("does not say a send did not happen unless the owner said so", () => {
    const ended = (disposition?: "activated" | "uncertain"): Extract<MachineCopy, { kind: "failed" }> => ({
      kind: "failed", op: "send", id: "window-1", message: "junto: backend did not respond",
      steps: ["verified", "quiescent"], installed: false, ...(disposition === undefined ? {} : { disposition }),
    });
    const item = listed({ setUp: false });
    // No word on how it ended, the new build switched in, or the owner itself unsure: all three may have changed the machine.
    for (const copy of [ended(), ended("activated"), ended("uncertain")]) {
      expect(machineCondition(item, undefined, copy)).toBe("send-unconfirmed");
      expect(machineSummary(item, undefined, copy)).toEqual({
        headline: "Could not confirm Junto was sent",
        advice: "junto: backend did not respond",
        needsYou: true,
      });
      // The steps that were confirmed stay; the rest are not said to be unreached.
      expect(machineStepLines(copy).map((line) => line.phase)).toEqual(["done", "done", "unconfirmed", "unconfirmed", "unconfirmed"]);
    }
    expect(machineCondition(listed(), peer(), { ...ended("uncertain"), op: "update" })).toBe("update-unconfirmed");
    expect(machineSummary(listed(), peer(), { ...ended(), op: "update", message: " " })).toMatchObject({
      headline: "Could not confirm Junto was updated",
      advice: "Check it before you update again.",
    });
    // Check first; sending again is the operator's choice, never the window's.
    expect(machineActions("send-unconfirmed")).toEqual(["check", "send", "remove"]);
    expect(machineActions("update-unconfirmed")).toEqual(["check", "update", "remove"]);
  });

  it("says Junto is on the machine when the install finished and what came after it failed", () => {
    const copy: MachineCopy = {
      kind: "failed", op: "send", id: "window-1", message: "the machine did not answer its setup",
      steps: ["verified", "ready"], installed: true,
    };
    const item = listed({ setUp: false });
    expect(machineCondition(item, undefined, copy)).toBe("sent-not-ready");
    expect(machineSummary(item, undefined, copy)).toEqual({
      headline: "Junto is on it, but it is not ready",
      advice: "the machine did not answer its setup",
      needsYou: true,
    });
    expect(machineCondition(listed(), peer(), { ...copy, op: "update" })).toBe("updated-not-ready");
    expect(machineActions("sent-not-ready")).toEqual(["check", "send", "remove"]);
    expect(machineActions("updated-not-ready")).toEqual(["check", "update", "remove"]);
    // The install is over: there is no step left to report on.
    expect(machineStepLines(copy)).toEqual([]);
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
      headline: "Cannot be reached",
      advice: "Check that it is on and that SSH reaches it.",
      needsYou: true,
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
    expect(machineSummary(listed(), peer(), undefined)).toEqual({ headline: "Ready", needsYou: false });
    expect(machineActions("ready")).toEqual(["check", "remove"]);
  });

  it("is not ready while seats placed on it lack a harness or a secret", () => {
    expect(machineSummary(listed(), peer(), undefined, { harnesses: ["claude", "codex"] })).toEqual({
      headline: "A harness is missing",
      advice: "Install Codex on Atlas. Its seats need it.",
      needsYou: true,
    });
    expect(machineSummary(listed(), peer({ missingSecrets: ["ANTHROPIC_API_KEY", "GH_TOKEN"] }), undefined)).toEqual({
      headline: "Secrets are missing",
      advice: "Set ANTHROPIC_API_KEY, GH_TOKEN on Atlas. Its seats need them.",
      needsYou: true,
    });
    expect(machineSummary(listed(), peer({ missingSecrets: ["GH_TOKEN"] }), undefined, { harnesses: ["codex"] })).toEqual({
      headline: "A harness and a secret are missing",
      advice: "Install Codex and set GH_TOKEN on Atlas. Its seats need them.",
      needsYou: true,
    });
    // The link's state is unchanged: it answered.
    expect(machineCondition(listed(), peer({ missingSecrets: ["GH_TOKEN"] }), undefined)).toBe("ready");
    // This machine too, and a harness no seat there uses is nobody's problem.
    // Only the machine the window runs on is ever called this machine.
    expect(machineSummary(thisMachine, own(), undefined, { harnesses: ["codex"] })).toEqual({
      headline: "A harness is missing",
      advice: "Install Codex on this machine. Its seats need it.",
      needsYou: true,
    });
    expect(machineSummary(thisMachine, own(), undefined, { harnesses: ["claude"] })).toEqual({ headline: "This machine", needsYou: false });
    // Nothing is said to be missing on a machine that has not answered.
    expect(machineSummary(listed(), peer({ reachable: false, harnesses: [] }), undefined, { harnesses: ["codex"] }).headline).toBe("Cannot be reached");
  });

  it("never offers to remove this machine", () => {
    expect(machineActions("this-machine")).not.toContain("remove");
  });
});

describe("the words for a machine", () => {
  it("call only the machine the window runs on this machine", () => {
    expect(machineNamed(thisMachine)).toBe("this machine");
    expect(machineNamed(listed())).toBe("Atlas");
    expect(machineNamed(listed({}, { label: " " }))).toBe(OTHER_MACHINE);
    // No line about another machine says "this machine", except the one that means where its seats run from.
    const failedCopy = (more: Partial<Extract<MachineCopy, { kind: "failed" }>>): MachineCopy => ({
      kind: "failed", op: "send", id: "window-1", message: "", steps: [], installed: false, ...more,
    });
    const lines = [
      machineSummary(listed({ setUp: false }), undefined, undefined),
      machineSummary(listed({ setUp: false }), undefined, failedCopy({ disposition: "staged" })),
      machineSummary(listed({ setUp: false }), undefined, failedCopy({})),
      machineSummary(listed(), peer(), failedCopy({ op: "update" })),
      machineSummary(listed({ setUp: false }), undefined, failedCopy({ installed: true })),
      machineSummary(listed(), peer(), failedCopy({ op: "update", installed: true })),
      machineSummary(listed(), undefined, undefined),
      machineSummary(listed(), { kind: "failed", message: "" }, undefined),
      machineSummary(listed(), peer({ reachable: false, harnesses: [] }), undefined),
      machineSummary(listed(), peer({ missingSecrets: ["GH_TOKEN"] }), undefined, { harnesses: ["codex"] }),
      machineSummary(listed(), peer(), undefined),
    ];
    for (const line of lines) {
      expect(`${line.headline} ${line.advice ?? ""}`).not.toMatch(/this machine|\bhere\b/iu);
    }
    expect(machineSummary(listed({ needsUpdate: true }), undefined, undefined).advice).toBe(
      "Update it before its seats can run from this machine.",
    );
  });
});

describe("the steps of a send", () => {
  it("join in the order they happen, once each", () => {
    expect(withInstallStep([], "verified")).toEqual(["verified"]);
    expect(withInstallStep(["verified"], "verified")).toEqual(["verified"]);
    expect(withInstallStep(["verified", "started"], "quiescent")).toEqual(["verified", "quiescent", "started"]);
  });

  it("stand as done, waited for now, or still ahead while the send runs", () => {
    const running = (steps: MachineCopy["steps"]): MachineCopy => ({ kind: "running", op: "send", id: "window-1", steps });
    expect(machineStepLines(running([])).map((line) => line.phase)).toEqual(["now", "ahead", "ahead", "ahead", "ahead"]);
    expect(machineStepLines(running(["verified", "quiescent"])).map((line) => line.phase)).toEqual(["done", "done", "now", "ahead", "ahead"]);
    // A step nobody reported, before one that was: not confirmed, and not said to be skipped.
    expect(machineStepLines(running(["verified", "selected"])).map((line) => line.phase)).toEqual(["done", "unconfirmed", "done", "now", "ahead"]);
    expect(machineStepLines(running(["verified"]))[1]).toEqual({ step: "quiescent", label: "Old Junto stopped", phase: "now" });
    expect(machineStepLines(undefined)).toEqual([]);
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
    const sending: MachineCopy = { kind: "running", op: "send", id: "window-1", steps: [] };
    const fine = [
      machineSummary(thisMachine, own(), undefined),
      machineSummary(listed(), peer(), undefined),
      machineSummary(listed(), undefined, undefined),
      machineSummary(listed({ setUp: false }), undefined, sending),
    ];
    expect(machinesNeedingAttention(fine)).toBe(0);
    const wanting = [
      machineSummary(listed({ setUp: false }), undefined, undefined),
      machineSummary(listed({ needsUpdate: true }), undefined, undefined),
      machineSummary(listed(), peer({ reachable: false, harnesses: [] }), undefined),
      machineSummary(listed(), { kind: "failed", message: "refused" }, undefined),
      machineSummary(listed(), peer({ missingSecrets: ["GH_TOKEN"] }), undefined),
    ];
    expect(machinesNeedingAttention([...fine, ...wanting])).toBe(5);
  });
});
