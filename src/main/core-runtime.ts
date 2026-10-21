import { Context, Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
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
import { LinkBuildMismatch, LinkPeerNotPinned, type LinkChannelHandler, type MachineLinkError } from "./junto/link/types";
import { encodeError, encodeFailure } from "./junto/failure-encode";
import { failureSentence } from "@shared/failure";
import { probeManagedHarnessInstalls } from "./junto/term/templates/harness-install";
import { makeRowsChannel } from "./junto/work/exchange/channel";
import { followLocalCommits, makeLiveRowExchange } from "./junto/work/exchange/live";
import { ResourceRuler } from "./junto/work/resource-ruler";
import { makeResourceSubmitLayer } from "./junto/work/resource-submit";
import type { RowExchange } from "./junto/work/exchange/session";
import { messageDelivery } from "./junto/work/message-delivery";
import { ContentService } from "./junto/content/service";
import { ContentPullFailed, makeContentChannel, makeContentPulls, pullContent, type PulledOwner } from "./junto/content/pull";
import type { ContentPullRefused, ResourceReached } from "@shared/content-pull";
import type { ContentRef } from "@shared/wire/content-ref";
import { BodyPuller } from "./junto/content/body-puller";
import { makeMachineFiles, pushFileToMachine } from "./junto/content/machine-files";
import { SshTransport } from "./junto/ssh";
import { makeMachineExchangeQuery } from "./junto/work/exchange/queries";
import { OPERATOR_PROTOCOL_VERSION, decodeOperatorResponse } from "@shared/operator-control";
import { makeSeatsChannel } from "./junto/term/seats-link";
import { readSeatWindow } from "./junto/term/seat-read";
import { makeCoreMailTransport, type CoreMailSeats } from "./junto/term/core-mail";
import { makeMessageDeliveryStore } from "./junto/work/message-delivery-store";
import { recordDeliveryReceiptRefusal } from "./junto/work/delivery-receipts";
import { mainAuthoringGate } from "./junto/main-authoring-gate";
import { KernelService, type KernelHost } from "./junto/kernel/service";
import { PausePlane } from "./junto/pause-plane";
import { pauseWasResumed } from "@shared/pause";
import type { AgentSignal } from "@shared/agent-signals";
import { setLogMachine, withMachineLogger } from "./junto/observability/logger";
import { MachineLogsNotSetUp, makePeerLogAnswer, receivePeerLogRead } from "./junto/observability/log-link";
import { readMachineLog } from "./junto/observability/log-file";
import { MachineLogQuery, MachineLogRead } from "@shared/machine-log";
import type { ModelService } from "./junto/model/service";
import type { ActorSeatOccupy } from "./junto/term/actor-seat-occupy";
import { startSeat, stopSeat } from "./junto/term/seat-control";
import { BoatPlane, boatPlaneLayer } from "./junto/boat/plane";
import { boatOwnerDispatch, makeBoatOwner } from "./junto/boat/owner";

export interface MachineCoreOptions {
  readonly home: string;
  readonly build: string;
  readonly bundles: MachineCopyOptions["bundles"];
  readonly acquireBundle?: MachineCopyOptions["acquireBundle"];
  readonly ready: () => boolean;
}

// The status channel answers a machine's status, or its log for the asking peer.
const MachineStatusRequest = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("machine") }),
  Schema.Struct({ kind: Schema.Literal("logs"), query: MachineLogQuery }),
]);
const rejectEvent = (): never => { throw new Error("The status channel has no events"); };

export class MachineCoreStatus extends Context.Service<MachineCoreStatus, {
  readonly own: Effect.Effect<MachineOwnStatus, unknown>;
  readonly harnesses: Effect.Effect<MachineHarnesses, unknown>;
  readonly handler: LinkChannelHandler;
}>()("@junto/MachineCoreStatus") {}

export class MachineCoreRows extends Context.Service<MachineCoreRows, {
  readonly exchange: RowExchange;
  readonly handler: LinkChannelHandler;
  /** The link's content channel: this machine serves the bodies of the canvases it edits. */
  readonly content: LinkChannelHandler;
  /**
   * Bring a resource body here from the machine that edits its canvas and keep
   * it under `owner`. The resource must be in reach of who asked: `reached`.
   */
  readonly pullBody: (input: { readonly ref: ContentRef; readonly owner: PulledOwner; readonly reached: ResourceReached }) => Effect.Effect<void, ContentPullRefused | ContentPullFailed>;
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
      acceptMessageDelivery: (canvas, nodeId, messageId, read) =>
        mainAuthoringGate.run("delivery.message-stamp", () => store.acceptMessageDelivery(canvas, nodeId, messageId, read))
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

class ExchangeStatusInvalid extends Schema.TaggedError<ExchangeStatusInvalid>()("ExchangeStatusInvalid", { message: Schema.String }) {}

const machineCoreRowsLayer = Layer.effect(MachineCoreRows, Effect.gen(function* () {
  const machines = yield* MachineRepository;
  const links = yield* MachineLink;
  const context = yield* Effect.context<never>();
  const fileContext = yield* Effect.context<HostsService | SshTransport | ContentService>();
  let notifySignal: ((signal: AgentSignal) => void) | undefined;
  // The editing machine rules held commands by sweep: at boot, and on each arrival.
  const ruler = yield* Effect.serviceOption(ResourceRuler);
  const sweep = (ruling: Effect.Effect<void, unknown>) => {
    void Effect.runPromiseWith(context)(ruling.pipe(
      Effect.catchCause((cause) => Effect.logWarning("held commands could not be ruled", cause).pipe(Effect.annotateLogs({ area: "rows" }))),
    ));
  };
  if (Option.isSome(ruler)) sweep(ruler.value.sweepAll);
  const exchange = yield* makeLiveRowExchange({
    mailArrived: (canvas, nodeId, message) => messageDelivery.notifyAppended(canvas, nodeId, message),
    ...(Option.isNone(ruler) ? {} : { commandArrived: (canvas: string) => sweep(ruler.value.sweep(canvas)) }),
    signalTaken: signal => notifySignal?.(signal),
    // The closing rule travels with the link close: logged at both ends and sent to the peer.
    linkFailed: (peer, cause) => {
      void Effect.runPromiseWith(context)(Effect.gen(function* () {
        const machine = (yield* machines.peers).find(machine => machine.installationId === peer);
        if (machine !== undefined) yield* links.disconnect(machine.machineName, cause);
      }).pipe(Effect.catchCause(failed => Effect.gen(function* () {
        const failure = encodeFailure(failed, { machine: yield* machines.machineName.pipe(Effect.orElseSucceed(() => "this-machine")) });
        yield* Effect.logWarning("the row exchange could not close its link").pipe(Effect.annotateLogs({ area: "link", ...(failure === undefined ? {} : { failure }) }));
      }))));
    },
  });
  messageDelivery.followLinks((canvas, nodeId) => Effect.runPromiseWith(context)(exchange.routed(canvas, nodeId)));
  const files = makeMachineFiles((machine, ref) => Effect.runPromiseWith(fileContext)(pushFileToMachine(machine, ref)));
  messageDelivery.followFiles(files.push);
  const store = yield* ContentService;
  const self = yield* machines.installationId;
  const content = makeContentChannel({
    root: store.root,
    canvas: (canvasName, peer) => exchange.placement(canvasName).pipe(Effect.map((placement) => ({ edits: placement?.editor === self, peerLinked: placement?.holds(peer) ?? false }))),
    verified: (ref) => store.heldVerified(ref),
    owners: (sha256) => store.listRefs(sha256).pipe(Effect.map((rows) => rows.map((row) => ({ kind: row.owner.kind, canvasName: row.owner.canvasName })))),
  });
  const pulls = makeContentPulls();
  const pullBody: MachineCoreRows["Service"]["pullBody"] = ({ ref, owner, reached }) => Effect.gen(function* () {
    const failed = (message: string) => new ContentPullFailed({ sha256: ref.sha256, byteLength: ref.byteLength, message });
    const placement = yield* exchange.placement(owner.canvasName);
    if (placement === undefined) return yield* Effect.fail(failed("this machine does not hold the canvas"));
    // The editing machine holds every body of its canvases already.
    if (placement.editor === self) return;
    const editor = (yield* machines.peers.pipe(Effect.orElseSucceed(() => []))).find((peer) => peer.installationId === placement.editor);
    if (editor === undefined) return yield* Effect.fail(failed("the machine that edits the canvas is not set up here"));
    const pull = pullContent({
      root: store.root,
      ask: (request) => links.request(editor.machineName, "content", request),
      keep: (kept, keptOwner) => store.keepPublished({ ref: kept, owner: keptOwner }),
      once: (object, transfer) => Effect.flatMap(Effect.promise(() => pulls.pull(object, () => Effect.runPromiseExit(transfer))), (exit) => exit),
    }, { ref, owner, reached });
    return yield* pull;
  });
  const stopFollowing = yield* followLocalCommits(exchange);
  yield* Effect.addFinalizer(() => Effect.sync(() => {
    stopFollowing();
    notifySignal = undefined;
    messageDelivery.followLinks(undefined);
    messageDelivery.followFiles(undefined);
    files.stop();
  }));
  return { exchange, handler: makeRowsChannel(exchange), content, pullBody, onSignalTaken: notify => { notifySignal = notify; } };
}));

export const machineCoreStatusLayer = (options: MachineCoreOptions) => Layer.effect(MachineCoreStatus, Effect.gen(function* () {
  const machines = yield* MachineRepository;
  const form = yield* detectMachineForm();
  const keychain = yield* detectMachineKeychain();
  const answerLogs = yield* makePeerLogAnswer(options.home);
  // Rows name this machine as the canvas does, not by host name.
  yield* machines.machineName.pipe(
    Effect.tap((name) => Effect.sync(() => setLogMachine(name))),
    Effect.catchCause((cause) => Effect.logWarning("the machine name could not be read; log rows use the host name", cause)),
    Effect.annotateLogs({ area: "machines" }),
  );
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
    decodeResponse: Schema.decodeUnknownSync(Schema.Union([MachinePeerStatus, MachineLogRead]), { onExcessProperty: "error" }),
    decodeEvent: rejectEvent,
    handleRequest: (context, payload) => {
      const request = payload as typeof MachineStatusRequest.Type;
      return request.kind === "logs" ? answerLogs(context.peer, request.query) : peer;
    },
  };
  return { own, harnesses, handler };
}));

/** Both entries add these services to their one owning runtime. */
export const makeMachineServicesLayer = (options: MachineCoreOptions) => {
  const links = machineLinkLayer(options.build);
  const status = Layer.provideMerge(machineCoreStatusLayer(options), links);
  const rows = Layer.provideMerge(machineCoreRowsLayer, status);
  const pulls = Layer.provideMerge(Layer.effect(BodyPuller, Effect.map(MachineCoreRows, (held) => ({ pull: held.pullBody }))), rows);
  // A seat's write on a canvas another machine edits is queued there, and waits for its ruling only while linked to it.
  const submit = Layer.provideMerge(
    Layer.unwrap(Effect.map(MachineCoreRows, (held) => makeResourceSubmitLayer((peer) => held.exchange.linked(peer)))),
    pulls,
  );
  const seats = Layer.provideMerge(machineCoreSeatsLayer, submit);
  const mail = Layer.provideMerge(machineCoreMailLayer, seats);
  const boat = Layer.provideMerge(boatPlaneLayer(options.home), mail);
  const owner = Layer.effect(MachineOwnerControl, Effect.gen(function* () {
    const link = yield* MachineLink;
    const machineStatus = yield* MachineCoreStatus;
    const rows = yield* MachineCoreRows;
    const exchangeQuery = yield* makeMachineExchangeQuery(rows.exchange);
    const hostsService = yield* HostsService;
    const machines = yield* MachineRepository;
    const seatServices = yield* Effect.context<ModelService | ActorSeatOccupy>();
    const copy = yield* makeMachineCopy({ build: options.build, bundles: options.bundles, acquireBundle: options.acquireBundle,
      connect: link.connect, connectSetup: link.connectSetup, disconnect: link.disconnect });
    const actions = yield* makeMachineOwnerActions({
      ownStatus: machineStatus.own,
      ownHarnesses: machineStatus.harnesses,
      ownLogs: (query) => Effect.flatMap(machines.machineName, (name) => readMachineLog(options.home, name, query)),
      peerLogs: (name, query) => Effect.gen(function* () {
        const host = yield* hostsService.get(name);
        const pin = yield* machines.peer(name);
        if (host === undefined || pin === undefined) return yield* new MachineLogsNotSetUp({ machine: name, message: `Set up ${name} before reading its log` });
        yield* link.connect(host);
        return yield* receivePeerLogRead(yield* link.request(name, "status", { kind: "logs", query }), name);
      }),
      peerBuild: link.peerBuild,
      // The window's start and stop path, with no window host step.
      seatStart: ({ canvas, seatId }) => startSeat({ canvas, seatId }).pipe(Effect.provideContext(seatServices)),
      seatStop: ({ canvas, seatId }) => stopSeat({ canvas, seatId }).pipe(Effect.provideContext(seatServices)),
      seatRead: ({ canvas, seatId, lines }) => readSeatWindow({ canvas, seatId, ...(lines === undefined ? {} : { lines }) }).pipe(
        Effect.map(({ hostId, window }) => window === undefined ? { hostId, vacant: true } : {
          hostId, vacant: false, generation: window.generation, text: window.text, lines: window.lines,
          cols: window.cols, rows: window.rows, truncated: window.truncated,
        }),
        Effect.provideContext(seatServices), Effect.provideService(MachineLink, link), Effect.provideService(HostsService, hostsService)),
      copy,
      disconnect: link.disconnect,
      peerStatus: (name) => Effect.gen(function* () {
        const host = yield* hostsService.get(name);
        const pin = yield* machines.peer(name);
        if (host === undefined || pin === undefined) return yield* Effect.fail(new LinkPeerNotPinned({ machine: name, message: `Set up ${name} first` }));
        const own = yield* machines.machineName;
        return yield* link.connect(host).pipe(
          Effect.andThen(link.request(name, "status", { kind: "machine" })),
          Effect.flatMap(Schema.decodeUnknownEffect(MachinePeerStatus, { onExcessProperty: "error" })),
          // Unreachable is an answer, and it says why: the typed failure, encoded and scrubbed.
          Effect.catch((cause: MachineLinkError | Schema.SchemaError) => Effect.gen(function* () {
            const failure = cause._tag === "LinkRequestFailed" ? cause.failure : encodeError(cause, { machine: own });
            yield* Effect.logWarning("machine status failed").pipe(Effect.annotateLogs({ area: "link", peer: name, failure }));
            return { machineName: name, reachable: cause instanceof LinkBuildMismatch, installationId: pin.installationId,
              harnesses: [], missingSecrets: [], failure,
              detail: cause instanceof LinkBuildMismatch ? "Update Junto on this machine" : failureSentence(failure).slice(0, 1024) };
          })),
        );
      }),
    });
    const boatPlane = yield* BoatPlane;
    const ownerContext = yield* Effect.context<never>();
    const boatOwner = yield* makeBoatOwner({
      home: boatPlane.home, machineName: boatPlane.machineName, client: boatPlane.client, machines: boatPlane.machines, log: boatPlane.log, run: boatPlane.run,
      getHost: (name) => Effect.runPromiseWith(ownerContext)(hostsService.get(name)),
      dispatch: (request, onTransition) => Effect.runPromiseWith(ownerContext)(actions.dispatch(request, onTransition)),
    });
    const boatDispatch = boatOwnerDispatch(boatOwner, boatPlane.machines, actions.dispatch);
    return MachineOwnerControl.of({ dispatch: (request, onTransition) => request.op !== "machine.exchange"
      ? boatDispatch(request, onTransition)
      : exchangeQuery(request.args).pipe(
        Effect.map(data => ({ protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, op: "machine.exchange" as const, ok: true as const, data })),
        Effect.flatMap(response => {
          const decoded = decodeOperatorResponse(response);
          return decoded._tag === "Success" ? Effect.succeed(decoded.success) : Effect.fail(new ExchangeStatusInvalid({ message: "Exchange status exceeds its contract" }));
        }),
        Effect.catchCause(cause => Effect.gen(function* () {
          const failure = encodeFailure(cause, { machine: yield* machines.machineName.pipe(Effect.orElseSucceed(() => "this-machine")) });
          yield* Effect.logWarning("machine exchange state could not be read").pipe(Effect.annotateLogs({ area: "link", ...(failure === undefined ? {} : { failure }) }));
          const why = failure === undefined ? "" : `: ${failureSentence(failure)}`;
          return { protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, op: request.op,
            ok: false as const, error: { type: "io" as const, message: `Could not read machine exchange state${why}`.slice(0, 1024), details: { retryable: true } } };
        })),
      ),
    });
  }));
  return Layer.provideMerge(owner, boat);
};

/** One StateEngine reference feeds identity, registry, link and owner commands. */
export const makeMachineCoreLayer = (options: MachineCoreOptions) => {
  return Layer.provideMerge(makeMachineServicesLayer(options), makeCoreProductLayer(options.home));
};

export const makeCoreRuntime = (options: MachineCoreOptions) =>
  ManagedRuntime.make(withMachineLogger(makeMachineCoreLayer(options)));
export type CoreRuntime = ReturnType<typeof makeCoreRuntime>;
