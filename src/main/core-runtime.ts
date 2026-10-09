import { join } from "node:path";
import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import {
  MachinePeerStatus,
  type MachineHarnesses,
  type MachineOwnStatus,
} from "@shared/machine-control";
import { makeStateEngineLive } from "./junto/state/engine";
import { MachineRepository, MachineRepositoryLive } from "./junto/machines/repository";
import { HostRegistryRows } from "./junto/hosts/registry";
import { HostsService, HostsServiceLive } from "./junto/hosts/service";
import { detectMachineForm } from "./junto/hosts/machine-form";
import { makeMachineCopy, type MachineCopyOptions } from "./junto/hosts/machine-copy";
import { MachineOwnerControl, makeMachineOwnerActions } from "./junto/hosts/machine-owner";
import { SshTransportLive } from "./junto/ssh";
import { MachineLink } from "./junto/link/service";
import { machineLinkLayer } from "./junto/link/live";
import type { LinkChannelHandler } from "./junto/link/types";
import { probeManagedHarnessInstalls } from "./junto/term/templates/harness-install";

export interface MachineCoreOptions {
  readonly home: string;
  readonly build: string;
  readonly bundles: MachineCopyOptions["bundles"];
  readonly ready: () => boolean;
}

const MachineStatusRequest = Schema.Struct({ kind: Schema.Literal("machine") });
const rejectEvent = (): never => { throw new Error("The status channel has no events"); };

export class MachineCoreStatus extends Context.Service<MachineCoreStatus, {
  readonly own: Effect.Effect<MachineOwnStatus, unknown>;
  readonly harnesses: Effect.Effect<MachineHarnesses, unknown>;
  readonly handler: LinkChannelHandler;
}>()("@junto/MachineCoreStatus") {}

export const machineCoreStatusLayer = (options: MachineCoreOptions) => Layer.effect(MachineCoreStatus, Effect.gen(function* () {
  const machines = yield* MachineRepository;
  const form = yield* detectMachineForm();
  const own = Effect.all({
    build: Effect.succeed(options.build),
    form: Effect.succeed(form),
    installationId: machines.installationId,
    machineName: machines.machineName,
    juntoHome: Effect.succeed(options.home),
    pid: Effect.succeed(process.pid),
    ready: Effect.sync(options.ready),
  });
  const harnesses = Effect.gen(function* () {
    const installed = yield* Effect.promise(() => probeManagedHarnessInstalls());
    return {
      machineName: yield* machines.machineName,
      reachable: true,
      harnesses: installed.map(({ harness, installed }) => ({ harness, installed })),
    };
  });
  const peer = Effect.gen(function* () {
    const status = yield* own;
    return { ...yield* harnesses, installationId: status.installationId, form: status.form, missingSecrets: [] };
  });
  const handler: LinkChannelHandler = {
    decodeRequest: Schema.decodeUnknownSync(MachineStatusRequest, { onExcessProperty: "error" }),
    decodeResponse: Schema.decodeUnknownSync(MachinePeerStatus, { onExcessProperty: "error" }),
    decodeEvent: rejectEvent,
    handleRequest: () => peer,
  };
  return { own, harnesses, handler };
}));

/** Both entries add these services to their one owning runtime. */
export const makeMachineServicesLayer = (options: MachineCoreOptions) => {
  const links = machineLinkLayer(options.build);
  const status = Layer.provideMerge(machineCoreStatusLayer(options), links);
  const owner = Layer.effect(MachineOwnerControl, Effect.gen(function* () {
    const link = yield* MachineLink;
    const machineStatus = yield* MachineCoreStatus;
    const hostsService = yield* HostsService;
    const machines = yield* MachineRepository;
    const copy = yield* makeMachineCopy({ build: options.build, bundles: options.bundles,
      connect: link.connect, connectSetup: link.connectSetup, disconnect: link.disconnect });
    return yield* makeMachineOwnerActions({
      ownStatus: machineStatus.own,
      ownHarnesses: machineStatus.harnesses,
      peerBuild: link.peerBuild,
      copy,
      disconnect: link.disconnect,
      peerStatus: (name) => Effect.gen(function* () {
        const host = yield* hostsService.get(name);
        const pin = yield* machines.peer(name);
        if (host === undefined || pin === undefined) return yield* Effect.fail(new Error("Set up this machine first"));
        return yield* link.connect(host).pipe(
          Effect.andThen(link.request(name, "status", { kind: "machine" })),
          Effect.flatMap(Schema.decodeUnknownEffect(MachinePeerStatus, { onExcessProperty: "error" })),
          Effect.catch(() => Effect.succeed({ machineName: name, reachable: false, installationId: pin.installationId,
            harnesses: [], missingSecrets: [], detail: "Cannot reach this machine" })),
        );
      }),
    });
  }));
  return Layer.provideMerge(owner, status);
};

/** One StateEngine reference feeds identity, registry, link and owner commands. */
export const makeMachineCoreLayer = (options: MachineCoreOptions) => {
  const state = makeStateEngineLive(join(options.home, ".junto", "state", "junto.db"));
  const identity = Layer.provideMerge(MachineRepositoryLive, state);
  const registry = Layer.provideMerge(HostRegistryRows.layer, identity);
  const hosts = Layer.provideMerge(HostsServiceLive, Layer.mergeAll(registry, SshTransportLive));
  return Layer.provideMerge(makeMachineServicesLayer(options), hosts);
};

export const makeCoreRuntime = (options: MachineCoreOptions) => ManagedRuntime.make(makeMachineCoreLayer(options));
export type CoreRuntime = ReturnType<typeof makeCoreRuntime>;
