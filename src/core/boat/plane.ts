/**
 * Boat in one core: the client on the account key, the routes every dial and
 * file push asks, and the machines that wake and sleep (docs/machines.md, Boat
 * machines). Built once per core; a core with no Boat machine and no account
 * does nothing with it.
 */
import { Context, Effect, Layer } from "effect";
import { HostsService } from "../hosts/service";
import { MachineLink } from "../link/service";
import { MachineRepository } from "../machines/repository";
import { readBoatAccountKey } from "./account";
import { boatKeyMissing, makeBoatClient, type BoatClient, type BoatRun } from "./client";
import { makeBoatMachines, makeBoatRoutes, type BoatMachines, type BoatRoutes, type BoatRoutesDeps } from "./machines";

export type BoatLog = (level: "Info" | "Warning", message: string, fields: Record<string, unknown>) => void;

/**
 * The Boat account and the routes found through it, before any link exists:
 * the link and the file plane take their route from here.
 */
export class BoatRoutesService extends Context.Service<BoatRoutesService, BoatRoutesDeps & {
  readonly routes: BoatRoutes;
}>()("@junto/BoatRoutes") {}

export const boatRoutesLayer = (home: string) => Layer.effect(BoatRoutesService, Effect.gen(function* () {
  const hosts = yield* HostsService;
  const context = yield* Effect.context<never>();
  const run: BoatRun = (effect) => Effect.runPromiseWith(context)(effect);
  const log: BoatLog = (level, message, fields) => {
    const write = level === "Info" ? Effect.logInfo : Effect.logWarning;
    Effect.runForkWith(context)(write(message).pipe(Effect.annotateLogs({ area: "boat", ...fields })));
  };
  const client = makeBoatClient({
    key: Effect.suspend(() => {
      const key = readBoatAccountKey(home);
      return key === undefined ? Effect.fail(boatKeyMissing()) : Effect.succeed(key);
    }),
  });
  const deps: BoatRoutesDeps = {
    home, client, log, run,
    getHost: (name) => run(hosts.get(name)),
    upsertHost: async (host) => { await run(hosts.upsert(host)); },
  };
  return BoatRoutesService.of({ ...deps, routes: makeBoatRoutes(deps) });
}));

export class BoatPlane extends Context.Service<BoatPlane, {
  readonly home: string;
  readonly client: BoatClient;
  readonly machines: BoatMachines;
  readonly machineName: () => Promise<string>;
  readonly log: BoatLog;
  readonly run: BoatRun;
}>()("@junto/BoatPlane") {}

export const boatPlaneLayer = (home: string) => Layer.effect(BoatPlane, Effect.gen(function* () {
  const boats = yield* BoatRoutesService;
  const link = yield* MachineLink;
  const repository = yield* MachineRepository;
  const machines = makeBoatMachines({
    home: boats.home, client: boats.client, log: boats.log, run: boats.run,
    getHost: boats.getHost, upsertHost: boats.upsertHost,
    routes: boats.routes,
    connect: async (host) => { await boats.run(link.connect(host)); },
    disconnect: (name) => boats.run(link.disconnect(name)),
  });
  return BoatPlane.of({ home, client: boats.client, machines, log: boats.log, run: boats.run, machineName: () => boats.run(repository.machineName) });
}));

/** A seat's start and a linked view ask this one thing of Boat; nothing else needs the machines. */
export class BoatWake extends Context.Service<BoatWake, {
  readonly wake: (name: string) => Promise<void>;
}>()("@junto/BoatWake") {}

export const boatWakeLayer = Layer.effect(BoatWake, Effect.map(BoatPlane, (plane) => ({
  wake: (name: string) => plane.machines.wakeIfBoat(name),
})));
