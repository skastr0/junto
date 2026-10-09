import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import {
  MachinePeerStatus,
  type MachineHarnesses,
  type MachineOwnStatus,
} from "@shared/machine-control";
import { MachineRepository } from "./junto/machines/repository";
import { HostsService } from "./junto/hosts/service";
import { detectMachineForm } from "./junto/hosts/machine-form";
import { detectMachineKeychain } from "./junto/hosts/machine-keychain";
import { machineHarnessSignIn } from "@shared/machine-harness-status";
import { makeMachineCopy, type MachineCopyOptions } from "./junto/hosts/machine-copy";
import { MachineOwnerControl, makeMachineOwnerActions } from "./junto/hosts/machine-owner";
import { makeCoreProductLayer } from "./core-product";
import { MachineLink } from "./junto/link/service";
import { machineLinkLayer } from "./junto/link/live";
import { LinkBuildMismatch } from "./junto/link/session";
import type { LinkChannelHandler } from "./junto/link/types";
import { probeManagedHarnessInstalls } from "./junto/term/templates/harness-install";
import { makeRowsChannel } from "./junto/work/exchange/channel";
import { followLocalCommits, makeLiveRowExchange } from "./junto/work/exchange/live";
import type { RowExchange } from "./junto/work/exchange/session";
import { messageDelivery } from "./junto/work/message-delivery";
import { makeMachineExchangeQuery } from "./junto/work/exchange/queries";
import { OPERATOR_PROTOCOL_VERSION, decodeOperatorResponse } from "@shared/operator-control";
import { makeSeatsChannel } from "./junto/term/seats-link";
import { makeCoreMailTransport, type CoreMailSeats } from "./junto/term/core-mail";
import { makeMessageDeliveryStore } from "./junto/work/message-delivery-store";
import { recordDeliveryReceiptRefusal } from "./junto/work/delivery-receipts";
import { mainAuthoringGate } from "./junto/main-authoring-gate";
import { KernelService, type KernelHost } from "./junto/kernel/service";
import { PausePlane } from "./junto/pause-plane";
import { pauseWasResumed } from "@shared/pause";
import type { AgentSignal } from "@shared/agent-signals";

export interface MachineCoreOptions {
  readonly home: string;
  readonly build: string;
  readonly bundles: MachineCopyOptions["bundles"];
  readonly acquireBundle?: MachineCopyOptions["acquireBundle"];
  readonly ready: () => boolean;
}

const MachineStatusRequest = Schema.Struct({ kind: Schema.Literal("machine") });
const rejectEvent = (): never => { throw new Error("The status channel has no events"); };

export class MachineCoreStatus extends Context.Service<MachineCoreStatus, {
  readonly own: Effect.Effect<MachineOwnStatus, unknown>;
  readonly harnesses: Effect.Effect<MachineHarnesses, unknown>;
  readonly handler: LinkChannelHandler;
}>()("@junto/MachineCoreStatus") {}

export class MachineCoreRows extends Context.Service<MachineCoreRows, {
  readonly exchange: RowExchange;
  readonly handler: LinkChannelHandler;
  readonly onSignalTaken: (notify: (signal: AgentSignal) => void) => void;
}>()("@junto/MachineCoreRows") {}

export class MachineCoreSeats extends Context.Service<MachineCoreSeats, {
  readonly handler: LinkChannelHandler;
}>()("@junto/MachineCoreSeats") {}

export class MachineCoreMail extends Context.Service<MachineCoreMail, {
  readonly seats: CoreMailSeats;
  readonly boot: (host: KernelHost) => Effect.Effect<void>;
}>()("@junto/MachineCoreMail") {}

const machineCoreSeatsLayer = Layer.effect(MachineCoreSeats,
  makeSeatsChannel().pipe(Effect.map(handler => ({ handler }))),
);

const machineCoreMailLayer = Layer.effect(MachineCoreMail, Effect.gen(function* () {
  const store = yield* makeMessageDeliveryStore;
  const seats = yield* makeCoreMailTransport();
  const pause = yield* PausePlane;
  const kernel = yield* KernelService;
  messageDelivery.configure({
    transport: seats.transport,
    store: {
      ...store,
      acceptMessageDelivery: (canvas, nodeId, messageId) =>
        mainAuthoringGate.run("delivery.message-stamp", () => store.acceptMessageDelivery(canvas, nodeId, messageId))
          .catch((cause: unknown) => {
            recordDeliveryReceiptRefusal(canvas, nodeId, cause);
            return false;
          }),
    },
  });
  const stopPause = pause.subscribe((canvas, previous, current) => {
    if (pauseWasResumed(previous, current)) messageDelivery.onResumed(canvas);
  });
  let booted = false;
  let stopped = false;
  seats.onSuspend(() => {
    stopped = true;
    stopPause();
    kernel.suspend();
  });
  return {
    seats,
    boot: (host) => Effect.gen(function* () {
      if (booted || stopped) return;
      booted = true;
      yield* pause.start;
      if (stopped) return;
      kernel.start(host);
      yield* Effect.promise(() => messageDelivery.onBooted());
    }),
  };
}));

const machineCoreRowsLayer = Layer.effect(MachineCoreRows, Effect.gen(function* () {
  const machines = yield* MachineRepository;
  const links = yield* MachineLink;
  const context = yield* Effect.context<never>();
  let notifySignal: ((signal: AgentSignal) => void) | undefined;
  const exchange = yield* makeLiveRowExchange({
    mailArrived: (canvas, nodeId, message) => messageDelivery.notifyAppended(canvas, nodeId, message),
    signalTaken: signal => notifySignal?.(signal),
    linkFailed: (peer) => {
      void Effect.runPromiseWith(context)(Effect.gen(function* () {
        const machine = (yield* machines.peers).find(machine => machine.installationId === peer);
        if (machine !== undefined) yield* links.disconnect(machine.machineName);
      })).catch(() => undefined);
    },
  });
  messageDelivery.followLinks((canvas, nodeId) => Effect.runPromiseWith(context)(exchange.routed(canvas, nodeId)));
  const stopFollowing = yield* followLocalCommits(exchange);
  yield* Effect.addFinalizer(() => Effect.sync(() => {
    stopFollowing();
    notifySignal = undefined;
    messageDelivery.followLinks(undefined);
  }));
  return { exchange, handler: makeRowsChannel(exchange), onSignalTaken: notify => { notifySignal = notify; } };
}));

export const machineCoreStatusLayer = (options: MachineCoreOptions) => Layer.effect(MachineCoreStatus, Effect.gen(function* () {
  const machines = yield* MachineRepository;
  const form = yield* detectMachineForm();
  const keychain = yield* detectMachineKeychain();
  const own = Effect.all({
    build: Effect.succeed(options.build),
    form: Effect.succeed(form),
    keychain: Effect.succeed(keychain),
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
      keychain,
      harnesses: installed.map(({ harness, installed }) => ({ harness, installed, signIn: machineHarnessSignIn(harness, installed, keychain) })),
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
  const rows = Layer.provideMerge(machineCoreRowsLayer, status);
  const seats = Layer.provideMerge(machineCoreSeatsLayer, rows);
  const mail = Layer.provideMerge(machineCoreMailLayer, seats);
  const owner = Layer.effect(MachineOwnerControl, Effect.gen(function* () {
    const link = yield* MachineLink;
    const machineStatus = yield* MachineCoreStatus;
    const rows = yield* MachineCoreRows;
    const exchangeQuery = yield* makeMachineExchangeQuery(rows.exchange);
    const hostsService = yield* HostsService;
    const machines = yield* MachineRepository;
    const copy = yield* makeMachineCopy({ build: options.build, bundles: options.bundles, acquireBundle: options.acquireBundle,
      connect: link.connect, connectSetup: link.connectSetup, disconnect: link.disconnect });
    const actions = yield* makeMachineOwnerActions({
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
          Effect.catch(cause => Effect.succeed({ machineName: name, reachable: cause instanceof LinkBuildMismatch, installationId: pin.installationId,
            harnesses: [], missingSecrets: [], detail: cause instanceof LinkBuildMismatch ? "Update Junto on this machine" : "Cannot reach this machine" })),
        );
      }),
    });
    return MachineOwnerControl.of({ dispatch: (request, onTransition) => request.op !== "machine.exchange"
      ? actions.dispatch(request, onTransition)
      : exchangeQuery(request.args).pipe(
        Effect.map(data => ({ protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, op: "machine.exchange" as const, ok: true as const, data })),
        Effect.flatMap(response => {
          const decoded = decodeOperatorResponse(response);
          return decoded._tag === "Success" ? Effect.succeed(decoded.success) : Effect.fail(new Error("Exchange status exceeds its contract"));
        }),
        Effect.catch(() => Effect.succeed({ protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, op: request.op,
          ok: false as const, error: { type: "io" as const, message: "Could not read machine exchange state", details: { retryable: true } } })),
      ),
    });
  }));
  return Layer.provideMerge(owner, mail);
};

/** One StateEngine reference feeds identity, registry, link and owner commands. */
export const makeMachineCoreLayer = (options: MachineCoreOptions) => {
  return Layer.provideMerge(makeMachineServicesLayer(options), makeCoreProductLayer(options.home));
};

export const makeCoreRuntime = (options: MachineCoreOptions) => ManagedRuntime.make(makeMachineCoreLayer(options));
export type CoreRuntime = ReturnType<typeof makeCoreRuntime>;
