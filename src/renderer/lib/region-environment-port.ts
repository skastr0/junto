/**
 * The region environment screen's port, bound to main. Each call is one
 * JuntoApi method; a build whose bridge does not carry them yet answers in
 * words instead of throwing, so the screen still opens and says what it
 * cannot do.
 */
import { getJuntoApi } from "./junto-api";
import type { PortResult, RegionEnvironmentPort } from "./region-environment";

const UNAVAILABLE = "This build of Junto cannot do that yet.";

type Bridge = {
  readonly regionEnvSaveSecret?: RegionEnvironmentPort["saveSecret"];
  readonly regionEnvRemoveSecret?: RegionEnvironmentPort["removeSecret"];
  readonly regionEnvReport?: RegionEnvironmentPort["report"];
  readonly regionEnvStaleSeats?: RegionEnvironmentPort["staleSeats"];
  readonly regionEnvRestartSeat?: RegionEnvironmentPort["restartSeat"];
};

const call = async <T>(run: (() => Promise<PortResult<T>>) | undefined): Promise<PortResult<T>> => {
  if (run === undefined) return { ok: false, message: UNAVAILABLE };
  try {
    return await run();
  } catch {
    // Never the thrown text: an IPC error can quote its arguments.
    return { ok: false, message: "Junto could not complete that. Try again." };
  }
};

export const regionEnvironmentPort = (): RegionEnvironmentPort => {
  const bridge = (): Bridge => (getJuntoApi() ?? {}) as Bridge;
  const bound = <A extends unknown[], T>(pick: (b: Bridge) => ((...args: A) => Promise<PortResult<T>>) | undefined) =>
    (...args: A): Promise<PortResult<T>> => {
      const method = pick(bridge());
      return call(method ? () => method(...args) : undefined);
    };
  return {
    saveSecret: bound((b) => b.regionEnvSaveSecret),
    removeSecret: bound((b) => b.regionEnvRemoveSecret),
    report: bound((b) => b.regionEnvReport),
    staleSeats: bound((b) => b.regionEnvStaleSeats),
    restartSeat: bound((b) => b.regionEnvRestartSeat),
  };
};
