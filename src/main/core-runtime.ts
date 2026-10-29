import { Cause, Context, Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
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
import { join } from "node:path";
import { makeMachineLinkSetup } from "./junto/hosts/machine-link";
import { homedir } from "node:os";
import { VAULT_ENABLED } from "@shared/features";
import { makeVaultSetup } from "./junto/vault/setup";
import { runTool } from "./junto/region-env/tool";
import { resolvedSpawnEnv } from "./junto/adapters/exec";
import { machinePackageCliDir } from "./junto/term/templates/seat-env";
import { automationRunnerLayer, makeCoreProductLayer } from "./core-product";
import { MachineLink } from "./junto/link/service";
import { machineLinkLayer } from "./junto/link/live";
import { LinkBuildMismatch, LinkPeerNotPinned, type LinkChannelHandler, type MachineLinkError } from "./junto/link/types";
import { encodeError, encodeFailure } from "./junto/failure-encode";
import { failureSentence } from "@shared/failure";
import { probeManagedHarnessInstalls } from "./junto/term/templates/harness-install";
import { makeRowsChannel } from "./junto/work/exchange/channel";
import { followLocalCommits, makeLiveRowExchange } from "./junto/work/exchange/live";
import { HeldSeatControls, makeHeldSeatControls } from "./junto/work/exchange/seat-controls";
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
import { ModelService } from "./junto/model/service";
import { ModelRecords } from "./junto/model/records";
import { SqlClient } from "effect/unstable/sql";
import { shotEntitled } from "./junto/content/shot-entitlement";
import { sweepPurgedShotCopies, unlessShotPurged } from "./junto/work/shot-purge";
import { OWNER_ENTITLEMENT, isPullableOwnerKind } from "@shared/content-pull";
import { signalFileEntitled } from "./junto/content/signal-entitlement";
import { AgentSignalRepository } from "./junto/signals/repository";
import { SignalFilePuller } from "./junto/signals/file-puller";
import { pullSignalFile as pullSignalFileHere } from "./junto/signals/file-pull";
import type { ActorSeatOccupy } from "./junto/term/actor-seat-occupy";
import { startSeat, stopSeat } from "./junto/term/seat-control";
import { BoatPlane, boatPlaneLayer } from "./junto/boat/plane";
import { readBoatRecords } from "./junto/boat/files";
import { startLinkKeeper, type LinkKeeper } from "./junto/link/keeper";
import { keepBoatMachines, pendingMailFor, startBoatKeeper, type BoatKeeperDeps } from "./junto/boat/keeper";
import { startBoatLease } from "./junto/boat/lease";
import { WorkRepository } from "./junto/work/repository";
import { BOAT_IDLE_MS } from "@shared/boat";
import { seatStateRuntime } from "./junto/term/agent-state/runtime";
import { termPlane } from "./junto/term/plane";
import { terminalObserverPlane } from "./junto/term/observer";
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
  /**
   * On the machine that edits the canvas: bring a file a seat's signal
   * attached here from the machine the seat lives on, keep it under the
   * signal, and record it as its own bytes say it is.
   */
  readonly pullSignalFile: SignalFilePuller["Service"]["pull"];
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
  const workRepository = yield* WorkRepository;
  const records = yield* ModelRecords;
  // Held controls judge on this machine's own fold: exchanged rows, sweeps
  // after each copy, and once at boot below.
  const heldControls = yield* makeHeldSeatControls(workRepository.seatControlRows);
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
  }).pipe(Effect.provideService(HeldSeatControls, heldControls));
  // A fold that slept resolves held controls as the boot's copy lands.
  yield* Effect.forkDetach(
    records.listCanvases().pipe(
      Effect.provideService(ModelRecords, records),
      Effect.flatMap((names) =>
        Effect.forEach(names, (canvasName) => heldControls.sweepPending(canvasName), { discard: true }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("held seat controls could not be swept").pipe(
          Effect.annotateLogs({ area: "exchange", error: Cause.pretty(cause) }),
        ),
      ),
    ),
  );
  messageDelivery.followLinks((canvas, nodeId) => Effect.runPromiseWith(context)(exchange.routed(canvas, nodeId)));
  const files = makeMachineFiles((machine, ref) => Effect.runPromiseWith(fileContext)(pushFileToMachine(machine, ref)));
  messageDelivery.followFiles(files.push);
  const store = yield* ContentService;
  const self = yield* machines.installationId;
  const sql = yield* SqlClient.SqlClient;
  // A purged shot's seat copies a sweep missed go now (B7).
  yield* sweepPurgedShotCopies(sql).pipe(Effect.catchCause((cause) => Effect.logWarning("purged shots' seat copies could not be swept", cause)));
  const model = yield* ModelService;
  const signals = yield* AgentSignalRepository;
  const content = makeContentChannel({
    root: store.root,
    canvas: (canvasName, peer) => exchange.placement(canvasName).pipe(Effect.map((placement) => ({ edits: placement?.editor === self, peerLinked: placement?.holds(peer) ?? false }))),
    verified: (ref) => store.heldVerified(ref),
    owners: (sha256, canvasName, peer) =>
      Effect.gen(function* () {
        const rows = yield* store.listRefs(sha256);
        const ruleOf = (kind: string) => (isPullableOwnerKind(kind) ? OWNER_ENTITLEMENT[kind] : undefined);
        const byRow = rows.filter(({ owner }) => ruleOf(owner.kind) === "row" && owner.canvasName === canvasName);
        const bySeat = rows.filter(({ owner }) => ruleOf(owner.kind) === "seat" && owner.canvasName === canvasName);
        const placement = byRow.length + bySeat.length === 0 ? undefined : yield* exchange.placement(canvasName);
        const seats = placement === undefined || byRow.length === 0 ? [] : [...(yield* model.canvas(canvasName)).nodes.values()].filter((node) => node.kind === "agent").map((node) => node.id);
        return yield* Effect.forEach(rows, ({ owner }) =>
          // An owner entitled by its row is judged on its own record, with the placement as it is now.
          placement !== undefined && byRow.some((row) => row.owner === owner)
            ? Effect.map(shotEntitled(sql, { owner, sha256, machine: peer, placement, seats }), (rowEntitled) => ({ kind: owner.kind, canvasName: owner.canvasName, rowEntitled }))
            : placement !== undefined && bySeat.some((row) => row.owner === owner)
              ? Effect.map(signalFileEntitled(signals, { owner, sha256, machine: peer, self, placement }), (rowEntitled) => ({ kind: owner.kind, canvasName: owner.canvasName, rowEntitled }))
              : Effect.succeed({ kind: owner.kind, canvasName: owner.canvasName }));
      }),
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
    // A shot the operator purged is never pulled again (B7).
    return yield* unlessShotPurged(sql, owner, pull, () => failed("the operator removed this shot"));
  });
  const pullSignalFile: MachineCoreRows["Service"]["pullSignalFile"] = (input) => pullSignalFileHere({
    self,
    placement: (canvasName) => exchange.placement(canvasName),
    machineName: (machine) => machines.peers.pipe(
      Effect.map((peers) => peers.find((peer) => peer.installationId === machine)?.machineName),
      Effect.orElseSucceed(() => undefined),
    ),
    ask: (machineName, request) => links.request(machineName, "content", request),
    root: store.root,
    keep: (ref, owner) => store.keepPublished({ ref, owner }),
    judged: (signalId, object, mediaType) => signals.judgeFile(signalId, object, mediaType),
    once: (object, transfer) => Effect.flatMap(Effect.promise(() => pulls.pull(object, () => Effect.runPromiseExit(transfer))), (exit) => exit),
  }, input);
  const stopFollowing = yield* followLocalCommits(exchange);
  yield* Effect.addFinalizer(() => Effect.sync(() => {
    stopFollowing();
    notifySignal = undefined;
    messageDelivery.followLinks(undefined);
    messageDelivery.followFiles(undefined);
    files.stop();
  }));
  return { exchange, handler: makeRowsChannel(exchange), content, pullBody, pullSignalFile, onSignalTaken: notify => { notifySignal = notify; } };
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

/**
 * The link keeper, started with the machine services: the window and the
 * windowless core both build them, so both redial a dropped link.
 */
export class MachineLinkKeeper extends Context.Service<MachineLinkKeeper, LinkKeeper>()("@junto/MachineLinkKeeper") {}

const machineLinkKeeperLayer = (home: string, ready: () => boolean) => Layer.effect(MachineLinkKeeper, Effect.gen(function* () {
  const hosts = yield* HostsService;
  const link = yield* MachineLink;
  const machines = yield* MachineRepository;
  const model = yield* ModelService;
  const rows = yield* MachineCoreRows;
  const context = yield* Effect.context<never>();
  const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromiseWith(context)(effect);
  const keeper = startLinkKeeper({
    self: yield* machines.machineName.pipe(Effect.orElseSucceed(() => "this-machine")),
    // A core that is not ready (booting, or stopping) dials nothing.
    peers: () => ready() ? run(machines.peers) : Promise.resolve([]),
    linked: (peer) => rows.exchange.linked(peer),
    wanted: (peer) => run(Effect.gen(function* () {
      for (const name of yield* model.listCanvases()) {
        if ((yield* rows.exchange.placement(name))?.holds(peer.installationId) === true) return true;
      }
      return false;
    })),
    boatMachines: async () => new Set((await readBoatRecords(home)).machines.map((row) => row.name)),
    getHost: (name) => run(hosts.get(name)),
    connect: async (host) => { await run(link.connect(host)); },
    log: (level, message, fields) => {
      const write = level === "Info" ? Effect.logInfo : Effect.logWarning;
      Effect.runForkWith(context)(write(message).pipe(Effect.annotateLogs({ area: "link", ...fields })));
    },
  });
  yield* Effect.addFinalizer(() => Effect.sync(keeper.stop));
  return MachineLinkKeeper.of({ pass: keeper.pass });
}));

/**
 * Boat in this machine's services (docs/machines.md, Boat machines): the
 * keeper for the Boat machines this one added, and the lease when this one is
 * a Boat machine. The window and the windowless core both build it.
 */
export class MachineBoatKeeper extends Context.Service<MachineBoatKeeper, {
  /** One keeper pass; answers which machines were woken and why. */
  readonly pass: () => ReturnType<typeof keepBoatMachines>;
}>()("@junto/MachineBoatKeeper") {}

const machineBoatKeeperLayer = (ready: () => boolean) => Layer.effect(MachineBoatKeeper, Effect.gen(function* () {
  const plane = yield* BoatPlane;
  const hosts = yield* HostsService;
  const link = yield* MachineLink;
  const context = yield* Effect.context<ModelService | WorkRepository>();
  const run = <A, E>(effect: Effect.Effect<A, E, ModelService | WorkRepository>): Promise<A> => Effect.runPromiseWith(context)(effect);
  const deps: BoatKeeperDeps = {
    home: plane.home, client: plane.client, machines: plane.machines, log: plane.log, run: plane.run,
    getHost: (name) => run(hosts.get(name)),
    connect: async (host) => { await run(link.connect(host)); },
    pendingMail: (machine) => run(pendingMailFor(machine)),
    ready,
  };
  const stopKeeper = startBoatKeeper(deps);
  const stopLease = startBoatLease({
    home: plane.home, log: plane.log, run: plane.run,
    busy: () => {
      if (seatStateRuntime.currentEvents().some((event) => event.state === "working")) return true;
      const since = Date.now() - BOAT_IDLE_MS;
      return termPlane.host.list().some((session) => (session.status === "running" || session.status === "starting") &&
        (terminalObserverPlane.lastOutputAt(session.bindingId) ?? 0) > since);
    },
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => { stopKeeper(); stopLease(); }));
  return MachineBoatKeeper.of({ pass: () => keepBoatMachines(deps, false) });
}));

/** Both entries add these services to their one owning runtime. */
export const makeMachineServicesLayer = (options: MachineCoreOptions) => {
  const links = machineLinkLayer(options.build, options.home);
  const status = Layer.provideMerge(machineCoreStatusLayer(options), links);
  const rows = Layer.provideMerge(machineCoreRowsLayer, status);
  const pulls = Layer.provideMerge(
    Layer.mergeAll(
      Layer.effect(BodyPuller, Effect.map(MachineCoreRows, (held) => ({ pull: held.pullBody }))),
      Layer.effect(SignalFilePuller, Effect.map(MachineCoreRows, (held) => ({ pull: held.pullSignalFile }))),
    ),
    rows,
  );
  // A seat's write on a canvas another machine edits is queued there, and waits for its ruling only while linked to it.
  const submit = Layer.provideMerge(
    Layer.unwrap(Effect.map(MachineCoreRows, (held) => makeResourceSubmitLayer((peer) => held.exchange.linked(peer)))),
    pulls,
  );
  const seats = Layer.provideMerge(machineCoreSeatsLayer, submit);
  const mail = Layer.provideMerge(machineCoreMailLayer, seats);
  const boat = Layer.provideMerge(
    Layer.mergeAll(machineLinkKeeperLayer(options.home, options.ready), machineBoatKeeperLayer(options.ready)),
    Layer.provideMerge(boatPlaneLayer(options.home), mail),
  );
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
    const linkSetup = yield* makeMachineLinkSetup({ home: options.home, juntoPath: () => {
      const bin = machinePackageCliDir();
      return bin === undefined ? undefined : join(bin, "junto");
    } });
    // Off in the ship build: no vault token is placed, recorded or listed.
    const vaultSetup = VAULT_ENABLED ? yield* makeVaultSetup({
      home: options.home, userHome: homedir(), run: runTool, path: async () => (await resolvedSpawnEnv()).PATH,
    }) : undefined;
    const actions = yield* makeMachineOwnerActions({
      linkSetup,
      ...(vaultSetup === undefined ? {} : { vaultSetup }),
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
  // The automation runner over both: it queues a write off the editing machine through the machine's submit path.
  return Layer.provideMerge(automationRunnerLayer, Layer.provideMerge(makeMachineServicesLayer(options), makeCoreProductLayer(options.home)));
};

export const makeCoreRuntime = (options: MachineCoreOptions) =>
  ManagedRuntime.make(withMachineLogger(makeMachineCoreLayer(options)));
export type CoreRuntime = ReturnType<typeof makeCoreRuntime>;
