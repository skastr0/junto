/**
 * Boat in one core: the client on the account key, the machines, and the
 * route every link dial asks (docs/machines.md, Boat machines). Built once per
 * core; a core with no Boat machine and no account does nothing with it.
 */
import { Context, Effect, Layer } from "effect";
import { HostsService } from "../hosts/service";
import { MachineLink } from "../link/service";
import { MachineRepository } from "../machines/repository";
import { readBoatAccountKey } from "./account";
import { boatKeyMissing, makeBoatClient, type BoatClient, type BoatRun } from "./client";
import { installBoatMachines, makeBoatMachines, type BoatMachines } from "./machines";

export type BoatLog = (level: "Info" | "Warning", message: string, fields: Record<string, unknown>) => void;

export class BoatPlane extends Context.Service<BoatPlane, {
  readonly home: string;
  readonly client: BoatClient;
  readonly machines: BoatMachines;
  readonly machineName: () => Promise<string>;
  readonly log: BoatLog;
  readonly run: BoatRun;
}>()("@junto/BoatPlane") {}

export const boatPlaneLayer = (home: string) => Layer.effect(BoatPlane, Effect.gen(function* () {
  const hosts = yield* HostsService;
  const link = yield* MachineLink;
  const repository = yield* MachineRepository;
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
  const machines = makeBoatMachines({
    home, client, log, run,
    getHost: (name) => run(hosts.get(name)),
    upsertHost: async (host) => { await run(hosts.upsert(host)); },
    connect: async (host) => { await run(link.connect(host)); },
    disconnect: (name) => run(link.disconnect(name)),
  });
  const uninstall = installBoatMachines(machines);
  yield* Effect.addFinalizer(() => Effect.sync(uninstall));
  return BoatPlane.of({ home, client, machines, log, run, machineName: () => run(repository.machineName) });
}));
