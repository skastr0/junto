/**
 * A core with no Boat account, for tests that build a link, a file push, a
 * seat start or the automation runner: every host dials as it is, no machine
 * is a Boat one, and a wake does nothing.
 */
import { Effect, Layer } from "effect";
import { BoatRoutesService, BoatWake } from "../../src/main/junto/boat/plane";
import { BoatMachineRefused, type BoatRoutes } from "../../src/main/junto/boat/machines";

const notBoat = (name: string) =>
  new BoatMachineRefused({ machine: name, check: "not-boat", message: `${name} is not a Boat machine` });

export const noBoatRoutes: BoatRoutes = {
  route: (host) => Promise.resolve(host),
  routeFields: async (name) => { throw notBoat(name); },
  view: async (name) => { throw notBoat(name); },
  record: async () => undefined,
};

export const noBoatRoutesLayer = Layer.succeed(BoatRoutesService, {
  home: "",
  client: {} as never,
  log: () => undefined,
  run: (effect) => Effect.runPromise(effect as never),
  getHost: async () => undefined,
  upsertHost: async () => undefined,
  routes: noBoatRoutes,
});

export const noBoatWakeLayer = Layer.succeed(BoatWake, { wake: async () => undefined });
