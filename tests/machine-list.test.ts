/**
 * The machines the canvas can place something on. The list comes from the
 * owner's machine.list, read once for the whole window; a picker offers this
 * machine and every other machine that is set up, and nothing else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPERATOR_PROTOCOL_VERSION } from "../src/shared/operator-control";
import type { RemoteHost } from "../src/shared/remote-hosts";
import {
  loadMachines,
  loadSetUpMachines,
  machineInWords,
  setUpMachinesIn,
} from "../src/renderer/lib/machines";
import { state$ } from "../src/renderer/lib/state";
import { OTHER_MACHINE, THIS_MACHINE } from "./support/machines";

type Request = { readonly id: string; readonly op: string };

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
