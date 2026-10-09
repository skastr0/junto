/**
 * The machines the canvas can place something on. The list comes from the
 * owner's machine.list, read once for the whole window; a picker offers this
 * machine and every other machine that is set up, and nothing else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPERATOR_PROTOCOL_VERSION } from "../src/shared/operator-control";
import type { RemoteHost } from "../src/shared/remote-hosts";
import { checkSeatMachine, forgetMachineChecks } from "../src/renderer/lib/machine-list";
import {
  loadMachines,
  loadSetUpMachines,
  machineInWords,
  seatMachineLine,
  setUpMachinesIn,
  type MachineFacts,
} from "../src/renderer/lib/machines";
import { state$ } from "../src/renderer/lib/state";
import { OTHER_MACHINE, THIS_MACHINE } from "./support/machines";

type Request = { readonly id: string; readonly op: string; readonly args: { readonly name?: string } };

const machine = (id: string, label: string, isThisMachine = false): RemoteHost => ({
  id, label, isThisMachine, capabilities: ["terminal"], ...(isThisMachine ? {} : { sshEndpoint: `op@${id}` }),
});
const LISTED = [
  { machine: machine(THIS_MACHINE, "Studio", true), setUp: true, needsUpdate: false, installationId: "inst-studio" },
  { machine: machine(OTHER_MACHINE, "Atlas"), setUp: true, needsUpdate: false, installationId: "inst-atlas" },
  { machine: machine("build-box", "Build box"), setUp: false, needsUpdate: false },
  { machine: machine("mini", "Mini"), setUp: true, needsUpdate: true, installationId: "inst-mini" },
];

const withOwner = (answer: (request: Request) => unknown) => {
  const machineCommand = vi.fn(async (request: Request) => answer(request));
  vi.stubGlobal("window", { junto: { machineCommand } });
  return machineCommand;
};
const listing = (machines: unknown) => (request: Request) => ({
  protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, op: request.op, ok: true, data: { machines },
});

beforeEach(() => {
  state$.machines.set([]);
  state$.machineFacts.set({});
  forgetMachineChecks();
});
afterEach(() => {
  vi.unstubAllGlobals();
  state$.machines.set([]);
  state$.machineFacts.set({});
});

describe("the machines something new can be placed on", () => {
  it("are this machine and every other machine that is set up", async () => {
    const owner = withOwner(listing(LISTED));
    const offered = await loadSetUpMachines();
    expect(offered.map((row) => row.id)).toEqual([THIS_MACHINE, OTHER_MACHINE, "mini"]);
    // One read, of the owner's list and nothing else.
    expect(owner.mock.calls.map(([request]) => request.op)).toEqual(["machine.list"]);
  });

  it("never include a machine that was only added, however it is listed", () => {
    const rows = LISTED.map((item) => item.machine);
    expect(setUpMachinesIn(rows, {}).map((row) => row.id)).toEqual([THIS_MACHINE]);
    expect(setUpMachinesIn(rows, { "build-box": { setUp: false, needsUpdate: false } }).map((row) => row.id)).toEqual([THIS_MACHINE]);
    expect(setUpMachinesIn(rows, { [OTHER_MACHINE]: { setUp: true, needsUpdate: false } }).map((row) => row.id)).toEqual([
      THIS_MACHINE, OTHER_MACHINE,
    ]);
  });

  it("still list every machine for its label", async () => {
    withOwner(listing(LISTED));
    expect((await loadMachines()).map((row) => row.label)).toEqual(["Studio", "Atlas", "Build box", "Mini"]);
    expect(state$.machineFacts.peek()).toEqual({
      [THIS_MACHINE]: { setUp: true, needsUpdate: false },
      [OTHER_MACHINE]: { setUp: true, needsUpdate: false },
      "build-box": { setUp: false, needsUpdate: false },
      mini: { setUp: true, needsUpdate: true },
    });
  });

  it("keep the last list when the owner refuses, and offer nothing new", async () => {
    withOwner(listing(LISTED));
    await loadMachines();
    withOwner(() => ({ protocol: OPERATOR_PROTOCOL_VERSION, ok: false, error: { type: "runtime_down", message: "Machine control is not ready" } }));
    expect((await loadSetUpMachines()).map((row) => row.id)).toEqual([THIS_MACHINE, OTHER_MACHINE, "mini"]);
  });

  it("are none but this machine when there is no machines surface", async () => {
    vi.stubGlobal("window", { junto: {} });
    expect(await loadSetUpMachines()).toEqual([]);
    expect(state$.machines.peek()).toEqual([]);
  });

  it("take nothing from a list that is not the owner's", async () => {
    withOwner((request) => ({ id: request.id, op: request.op, ok: true, data: { machines: LISTED } }));
    expect(await loadSetUpMachines()).toEqual([]);
  });
});

describe("how a line names a machine", () => {
  const rows = LISTED.map((item) => item.machine);

  it("says this machine only for the one the window runs on", () => {
    expect(machineInWords(rows, THIS_MACHINE, THIS_MACHINE)).toBe("this machine");
    expect(machineInWords(rows, OTHER_MACHINE, THIS_MACHINE)).toBe("Atlas");
    expect(machineInWords(rows, "gone", THIS_MACHINE)).toBe("gone");
    // Before this machine's name is known, nothing is called this machine.
    expect(machineInWords(rows, THIS_MACHINE, "")).toBe("Studio");
  });
});

describe("why a seat cannot run where it is placed", () => {
  const rows = LISTED.map((item) => item.machine);
  const line = (host: string, facts: Record<string, MachineFacts>, harness: string | undefined = "codex") =>
    seatMachineLine({ host, harness, thisName: THIS_MACHINE, machines: rows, facts });
  const READY: MachineFacts = { setUp: true, needsUpdate: false };

  it("is nothing for a seat on this machine, or on a machine that answered and has its harness", () => {
    expect(line(THIS_MACHINE, { [THIS_MACHINE]: READY })).toBeUndefined();
    expect(line(OTHER_MACHINE, { [OTHER_MACHINE]: { ...READY, reachable: true, harnesses: ["claude", "codex"] } })).toBeUndefined();
  });

  it("says nothing before there is something to say", () => {
    // The list has not been read, or this machine's name is not known yet.
    expect(seatMachineLine({ host: OTHER_MACHINE, harness: "codex", thisName: THIS_MACHINE, machines: [], facts: {} })).toBeUndefined();
    expect(seatMachineLine({ host: OTHER_MACHINE, harness: "codex", thisName: "", machines: rows, facts: {} })).toBeUndefined();
    // Set up and not asked yet: nothing is known against it.
    expect(line(OTHER_MACHINE, { [OTHER_MACHINE]: READY })).toBeUndefined();
  });

  it("names the machine, what happened and what to do", () => {
    expect(line("gone", {})).toEqual({
      state: "not-listed", line: "gone is not one of your machines. Add it in Machines, or move this seat.",
    });
    expect(line("build-box", { "build-box": { setUp: false, needsUpdate: false } })).toEqual({
      state: "not-set-up", line: "Junto is not on Build box yet. Send it from Machines.",
    });
    expect(line("mini", { mini: { setUp: true, needsUpdate: true } })).toEqual({
      state: "needs-update", line: "Mini runs a different build of Junto. Update it from Machines.",
    });
    expect(line(OTHER_MACHINE, { [OTHER_MACHINE]: { ...READY, reachable: false } })).toEqual({
      state: "unreachable", line: "Cannot reach Atlas. Check that it is on.",
    });
    expect(line(OTHER_MACHINE, { [OTHER_MACHINE]: { ...READY, reachable: true, harnesses: ["claude"] } })).toEqual({
      state: "harness-missing", line: "Codex is not on Atlas. Install it there, or move this seat.",
    });
  });

  it("never calls another machine this machine", () => {
    const facts: Record<string, MachineFacts> = {
      "build-box": { setUp: false, needsUpdate: false },
      mini: { setUp: true, needsUpdate: true },
      [OTHER_MACHINE]: { ...READY, reachable: false },
    };
    for (const host of ["gone", "build-box", "mini", OTHER_MACHINE]) {
      expect(line(host, facts)?.line).not.toMatch(/this machine/iu);
    }
  });
});

describe("asking a machine for the seats placed on it", () => {
  const status = (more: Record<string, unknown>) => (request: Request) =>
    request.op === "machine.list"
      ? listing(LISTED)(request)
      : {
          protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, op: request.op, ok: true,
          data: { machineName: request.args.name, reachable: true, harnesses: [{ harness: "claude", installed: true }, { harness: "codex", installed: false }], missingSecrets: [], ...more },
        };
  const ops = (owner: ReturnType<typeof withOwner>) => owner.mock.calls.map(([request]) => `${request.op} ${request.args.name ?? ""}`.trim());

  it("asks the machine once and reads the resulting facts, however many seats ask", async () => {
    const owner = withOwner(status({}));
    await Promise.all([checkSeatMachine(OTHER_MACHINE, 1_000), checkSeatMachine(OTHER_MACHINE, 1_000), checkSeatMachine(OTHER_MACHINE, 2_000)]);
    expect(ops(owner)).toEqual(["machine.list", `machine.status ${OTHER_MACHINE}`, "machine.list"]);
    expect(state$.machineFacts.peek()[OTHER_MACHINE]).toEqual({ setUp: true, needsUpdate: false, reachable: true, harnesses: ["claude"] });
    // Later, it may be asked again.
    await checkSeatMachine(OTHER_MACHINE, 40_000);
    expect(ops(owner)).toEqual(["machine.list", `machine.status ${OTHER_MACHINE}`, "machine.list", "machine.list", `machine.status ${OTHER_MACHINE}`, "machine.list"]);
  });

  it("shows a different build discovered by the first status check as needing an update", async () => {
    let needsUpdate = false;
    withOwner(request => {
      if (request.op === "machine.list") {
        return listing(LISTED.map(item => item.machine.id === OTHER_MACHINE ? { ...item, needsUpdate } : item))(request);
      }
      needsUpdate = true;
      return status({ reachable: true, harnesses: [], detail: "Update Junto on this machine" })(request);
    });
    await checkSeatMachine(OTHER_MACHINE, 1_000);
    expect(state$.machineFacts.peek()[OTHER_MACHINE]).toEqual({ setUp: true, needsUpdate: true });
  });

  it("does not ask a machine that has no link to answer over", async () => {
    const owner = withOwner(status({}));
    await checkSeatMachine("build-box", 1_000);
    await checkSeatMachine("mini", 1_000);
    await checkSeatMachine(THIS_MACHINE, 1_000);
    await checkSeatMachine("gone", 1_000);
    expect(ops(owner)).toEqual(["machine.list"]);
  });

  it("records a machine that did not answer, and says nothing of its harnesses", async () => {
    withOwner(status({ reachable: false, harnesses: [], detail: "SSH did not answer" }));
    await checkSeatMachine(OTHER_MACHINE, 1_000);
    expect(state$.machineFacts.peek()[OTHER_MACHINE]).toEqual({ setUp: true, needsUpdate: false, reachable: false });
  });

  it("leaves the facts as they were when the question is refused", async () => {
    withOwner((request) =>
      request.op === "machine.list"
        ? listing(LISTED)(request)
        : { protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, op: request.op, ok: false, error: { type: "io", message: "the link dropped" } });
    await checkSeatMachine(OTHER_MACHINE, 1_000);
    expect(state$.machineFacts.peek()[OTHER_MACHINE]).toEqual({ setUp: true, needsUpdate: false });
  });

  it("forgets what a machine said once it runs another build", async () => {
    withOwner(status({}));
    await checkSeatMachine(OTHER_MACHINE, 1_000);
    withOwner(listing(LISTED.map((item) => (item.machine.id === OTHER_MACHINE ? { ...item, needsUpdate: true } : item))));
    await loadMachines();
    expect(state$.machineFacts.peek()[OTHER_MACHINE]).toEqual({ setUp: true, needsUpdate: true });
  });
});
