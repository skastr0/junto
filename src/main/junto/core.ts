import { Context, Effect, Schema } from "effect";
import { join } from "node:path";
import type { CoreRuntime, MachineCoreOptions } from "../core-runtime";
import { makeCoreRuntime } from "../core-runtime";
import { MachineCoreStatus, MachineCoreRows, MachineCoreSeats, MachineCoreMail } from "../core-runtime";
import { makeInventoryChannel } from "./inventory/channel";
import { makeNativeConfigChannel } from "./inventory/native-channel";
import { makeSettingsChannel } from "./settings/link-channel";
import { MachineOwnerControl } from "./hosts/machine-owner";
import { MachineLink, type MachineLinkListener } from "./link/service";
import { startOperatorControlServer, type OperatorControlServer } from "./operator-control";
import { evaluateSchemaCompatibility, probeInstalledStateSchema } from "./state/schema-version-probe";
import { quiesceServiceChildrenOnQuit } from "../services/process";
import { installCoreRunner } from "../core-runner";
import { startWorkControlServer, type WorkControlServer } from "./work/control";
import { workControlDir } from "@shared/work-control";
import { startCoreSeats } from "./term/core-seats";
import { startSeatSessions, type SeatSessions } from "./seat-sessions/start-seat-sessions";
import { wireSeatReports } from "./term/agent-state/seat-reports";
import { seatStateRuntime } from "./term/agent-state/runtime";
import { termPlane } from "./term/plane";
import { AgentSignalRepository } from "./signals/repository";
import { onAgentSignalChanged } from "./signals/changes";
import { mainAuthoringGate } from "./main-authoring-gate";
import { BOAT_IDLE_MS } from "@shared/boat";
import { pendingMailFor, startBoatKeeper } from "./boat/keeper";
import { startBoatLease } from "./boat/lease";
import { BoatPlane } from "./boat/plane";
import { HostsService } from "./hosts/service";
import { terminalObserverPlane } from "./term/observer";
import { readBoatRecords } from "./boat/files";
import { startLinkKeeper } from "./link/keeper";
import { MachineRepository } from "./machines/repository";
import { ModelService } from "./model/service";

export type CoreOptions = Omit<MachineCoreOptions, "ready">;

/** The installed database is newer than this build; starting would corrupt it. */
export class CoreSchemaTooNew extends Schema.TaggedError<CoreSchemaTooNew>()("CoreSchemaTooNew", {
  userVersion: Schema.Number,
  supportedVersion: Schema.Number,
  message: Schema.String,
}) {}

/** A stop that could not finish: the named part still held work, so core state was kept. */
export class CoreDidNotDrain extends Schema.TaggedError<CoreDidNotDrain>()("CoreDidNotDrain", {
  part: Schema.Literals(["owner-commands", "seat-work", "writes", "service-children"]),
  remaining: Schema.optionalKey(Schema.Number),
  message: Schema.String,
}) {}

/**
 * Boat in this core (docs/machines.md, Boat machines): the keeper for the Boat
 * machines this one added, and the lease when this one is a Boat machine.
 */
const startBoat = async (runtime: CoreRuntime): Promise<() => void> => {
  const plane = await runtime.runPromise(BoatPlane);
  const [hosts, link] = await runtime.runPromise(Effect.all([HostsService, MachineLink]));
  const stopKeeper = startBoatKeeper({
    home: plane.home, client: plane.client, machines: plane.machines, log: plane.log, run: plane.run,
    getHost: (name) => runtime.runPromise(hosts.get(name)),
    connect: async (host) => { await runtime.runPromise(link.connect(host)); },
    pendingMail: (machine) => runtime.runPromise(pendingMailFor(machine)),
  });
  const stopLease = startBoatLease({
    home: plane.home, log: plane.log, run: plane.run,
    busy: () => {
      if (seatStateRuntime.currentEvents().some((event) => event.state === "working")) return true;
      const since = Date.now() - BOAT_IDLE_MS;
      return termPlane.host.list().some((session) => (session.status === "running" || session.status === "starting") &&
        (terminalObserverPlane.lastOutputAt(session.bindingId) ?? 0) > since);
    },
  });
  return () => { stopKeeper(); stopLease(); };
};

/** The link keeper in this core: a dropped link to a machine that shares a canvas with this one is dialed again. */
const startLinks = async (runtime: CoreRuntime, home: string): Promise<() => void> => {
  const [hosts, link, machines, model, rows] = await runtime.runPromise(Effect.all([HostsService, MachineLink, MachineRepository, ModelService, MachineCoreRows]));
  return startLinkKeeper({
    peers: () => runtime.runPromise(machines.peers),
    linked: (peer) => rows.exchange.linked(peer),
    wanted: (peer) => runtime.runPromise(Effect.gen(function* () {
      for (const name of yield* model.listCanvases()) {
        if ((yield* rows.exchange.placement(name))?.holds(peer.installationId) === true) return true;
      }
      return false;
    })),
    boatMachines: async () => new Set((await readBoatRecords(home)).machines.map((row) => row.name)),
    getHost: (name) => runtime.runPromise(hosts.get(name)),
    connect: async (host) => { await runtime.runPromise(link.connect(host)); },
    log: (level, message, fields) => {
      const write = level === "Info" ? Effect.logInfo : Effect.logWarning;
      runtime.runFork(write(message).pipe(Effect.annotateLogs({ area: "link", ...fields })));
    },
  });
};

/** Both shells use this owner/link lifecycle; it creates no canvas. */
export const startCore = async (options: CoreOptions) => {
  const schema = evaluateSchemaCompatibility(probeInstalledStateSchema(join(options.home, ".junto", "state", "junto.db")));
  if (!schema.ok) {
    throw new CoreSchemaTooNew({
      userVersion: schema.userVersion,
      supportedVersion: schema.supportedVersion,
      message: `Update Junto: this database uses schema ${schema.userVersion}, this build supports ${schema.supportedVersion}`,
    });
  }
  let admitted = false;
  let stopping = false;
  let owner: OperatorControlServer | undefined;
  let listener: MachineLinkListener | undefined;
  let work: WorkControlServer | undefined;
  let seatProcesses: Awaited<ReturnType<typeof startCoreSeats>> | undefined;
  let mail: Context.Service.Shape<typeof MachineCoreMail> | undefined;
  let sessions: SeatSessions | undefined;
  let stopSeatReports: (() => void) | undefined;
  let releaseRunner: (() => void) | undefined;
  let stopBoat: (() => void) | undefined;
  let stopLinks: (() => void) | undefined;
  const runtime = makeCoreRuntime({ ...options, ready: () => admitted && !stopping && owner?.ready() === true && listener?.ready() === true });
  let closeFlight: Promise<void> | undefined;
  /** `cause` says why this core stops; each linked machine reads it in the close frame. */
  const close = (cause?: unknown): Promise<void> => {
    if (closeFlight !== undefined) return closeFlight;
    stopping = true;
    admitted = false;
    owner?.beginShutdown();
    listener?.beginShutdown(cause);
    work?.beginShutdown();
    mail?.seats.suspend();
    sessions?.stop();
    stopSeatReports?.();
    stopBoat?.();
    stopLinks?.();
    seatProcesses?.beginShutdown();
    closeFlight = (async () => {
      if (owner !== undefined) {
        const receipt = await owner.close();
        if (!receipt.clean) throw new CoreDidNotDrain({ part: "owner-commands", message: "Owner commands did not drain; core state retained" });
      }
      if (listener !== undefined) await listener.close(cause);
      if (work !== undefined) {
        const receipt = await work.close();
        if (!receipt.clean) throw new CoreDidNotDrain({ part: "seat-work", message: "Seat work commands did not drain; core state retained" });
      }
      await seatProcesses?.close();
      const writes = await mainAuthoringGate.drain(5_000);
      if (writes.remaining.length > 0) {
        throw new CoreDidNotDrain({ part: "writes", remaining: writes.remaining.length, message: "Core writes did not drain; core state retained" });
      }
      await runtime.dispose();
      const children = await quiesceServiceChildrenOnQuit();
      if (!children.clean) throw new CoreDidNotDrain({ part: "service-children", message: "Core service children did not drain" });
      releaseRunner?.();
    })();
    return closeFlight;
  };
  try {
    releaseRunner = installCoreRunner(runtime);
    const [actions, link, status, rows, seats, coreMail] = await runtime.runPromise(Effect.all([MachineOwnerControl, MachineLink, MachineCoreStatus, MachineCoreRows, MachineCoreSeats, MachineCoreMail]));
    mail = coreMail;
    work = await startWorkControlServer({
      home: options.home, workHome: workControlDir(options.home),
      version: typeof __JUNTO_APP_VERSION__ === "string" ? __JUNTO_APP_VERSION__ : "dev",
      run: effect => runtime.runPromise(effect),
    });
    seatProcesses = await startCoreSeats({ home: options.home });
    const inventory = await runtime.runPromise(makeInventoryChannel());
    const nativeConfig = await runtime.runPromise(makeNativeConfigChannel());
    const settings = await runtime.runPromise(makeSettingsChannel());
    await runtime.runPromise(link.setChannels({ status: status.handler, rows: rows.handler, content: rows.content, seats: seats.handler, inventory, settings, "native-config": nativeConfig }));
    listener = await runtime.runPromise(link.listen(options.home));
    owner = await startOperatorControlServer({ home: options.home, dispatch: (request) => runtime.runPromise(actions.dispatch(request)) });
    await runtime.runPromise(mail.boot({
      runPromise: effect => runtime.runPromise(effect),
      runFork: effect => { runtime.runFork(effect); },
    }));
    // The seats this machine runs keep their sessions here: an agent's own
    // offboard is closed, and the cut runs, with no window.
    sessions = await startSeatSessions({
      run: effect => runtime.runPromise(effect),
      onSuspend: listener => { coreMail.seats.onSuspend(listener); },
    });
    // A seat's declared signals (blocked, escalate, feedback) ride its own
    // snapshot, as in the window, so a seat waiting on the operator is
    // exempt from the cut here too.
    stopSeatReports = wireSeatReports({
      sessions: () => termPlane.host.list(),
      seatReported: (bindingId, report) => seatStateRuntime.seatReported(bindingId, report),
      subscribeSeatState: (listener) => seatStateRuntime.subscribe(listener),
      onSignalChanged: onAgentSignalChanged,
      signalsOf: (canvasName, nodeId) =>
        runtime.runPromise(Effect.flatMap(AgentSignalRepository, (signals) => signals.listSeat({ canvasName, nodeId }))),
    });
    stopBoat = await startBoat(runtime);
    stopLinks = await startLinks(runtime, options.home);
    admitted = true;
    return { runtime, close, ready: () => admitted && !stopping && owner!.ready() && listener!.ready() };
  } catch (cause) {
    // The start failure is the reason worth keeping; a stop that also fails is logged beside it.
    await close().catch((closeCause: unknown) => {
      console.error("[core] Junto core could not stop after a failed start", closeCause);
    });
    throw cause;
  }
};
