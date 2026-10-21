import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { Effect, Schema } from "effect";
import { expect, it } from "vitest";
import { makeCoreRuntime, MachineBoatKeeper, MachineLinkKeeper } from "../src/main/core-runtime";
import { HostsService } from "../src/main/junto/hosts/service";
import { MachineRepository } from "../src/main/junto/machines/repository";
import { ModelService } from "../src/main/junto/model/service";
import { MachinePeerIdentity } from "../src/shared/machine-control";
import { Command } from "../src/shared/model";

const source = (relative: string): string => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

it("the window boots the link and Boat keepers: its runtime is the machine core layer, and nothing else starts one", () => {
  // The window's one runtime is AppRuntime, built over the machine core layer (the windowless core builds the same).
  const window = source("src/main/runtime.ts");
  expect(window).toMatch(/const MachineServicesLive = Layer\.unwrap\([\s\S]*return makeMachineCoreLayer\(/u);
  expect(window).toMatch(/export const RootLayer = MachineServicesLive;/u);
  expect(window).toMatch(/const AppLayer = withMachineLogger\(Layer\.mergeAll\(RootLayer,/u);
  for (const path of ["src/main/index.ts", "src/main/runtime.ts", "src/main/junto/core.ts", "src/main/headless.ts"]) {
    for (const start of ["startLinkKeeper", "startBoatKeeper", "startBoatLease"]) expect(source(path), path).not.toContain(start);
  }
});

it("the machine core layer starts both keepers; the link keeper redials a machine with a seat on a held canvas and never an idle one", async () => {
  const home = await mkdtemp("/tmp/junto-keeper-");
  let ready = false;
  const runtime = makeCoreRuntime({ home, build: "a".repeat(64), bundles: {}, ready: () => ready });
  try {
    const keeper = await runtime.runPromise(MachineLinkKeeper);
    // No Boat machine added here: a Boat pass wakes nothing and asks Boat nothing.
    expect(await (await runtime.runPromise(MachineBoatKeeper)).pass()).toEqual([]);
    const [machines, hosts, model] = await runtime.runPromise(Effect.all([MachineRepository, HostsService, ModelService]));
    for (const machineName of ["m2", "idle"]) {
      await runtime.runPromise(machines.pinPeer(Schema.decodeUnknownSync(MachinePeerIdentity)({ machineName, installationId: `${machineName}-installation` })));
      await runtime.runPromise(hosts.upsert({
        id: machineName, label: machineName, isThisMachine: false, sshEndpoint: machineName,
        juntoHome: `/scratch/${machineName}`, installRoot: `/scratch/${machineName}/install`, capabilities: ["terminal"],
      }));
    }
    const command = Schema.decodeUnknownSync(Command);
    await runtime.runPromise(model.command(command({ _tag: "CreateCanvas", canvas: "held" }), "operator"));
    await runtime.runPromise(model.command(command({ _tag: "Add", canvas: "held", nodes: [{
      kind: "agent", id: "seat-n", x: 0, y: 0, width: 200, height: 100, z: 0,
      label: "Seat", agentKey: "local:seat-n", bindingId: "seat-n-binding", host: "m2",
      harness: "codex", overseer: false,
    }], wires: [] }), "operator"));
    // A core that is not ready (booting, or stopping) dials nothing.
    expect(await keeper.pass()).toEqual([]);
    // No link is open and no status is read: one pass dials m2 alone.
    ready = true;
    expect(await keeper.pass()).toEqual(["m2"]);
  } finally {
    await runtime.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
