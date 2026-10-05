import type {
  PortResult,
  RegionEnvironmentPort,
  SourceReport,
  StaleSeat,
} from "../../src/renderer/lib/region-environment";

/**
 * A scripted port for the region environment screen: what main would answer,
 * and a record of everything the screen asked. Never touches a real store.
 */
export const makeFakeRegionEnvironmentPort = (script: {
  report?: ReadonlyArray<SourceReport>;
  seats?: ReadonlyArray<StaleSeat>;
  saveSecret?: PortResult<{ readonly secretId: string }>;
  reportFailure?: string;
  restart?: PortResult<object>;
} = {}) => {
  const calls = {
    saveSecret: [] as Array<Parameters<RegionEnvironmentPort["saveSecret"]>[0]>,
    removeSecret: [] as string[],
    report: [] as string[],
    staleSeats: [] as string[],
    restartSeat: [] as string[],
  };
  const state = { ...script };
  let minted = 0;
  const port: RegionEnvironmentPort = {
    saveSecret: async (input) => {
      calls.saveSecret.push(input);
      if (state.saveSecret) return state.saveSecret;
      minted += 1;
      return { ok: true, secretId: input.secretId ?? `secret-${minted}` };
    },
    removeSecret: async (secretId) => {
      calls.removeSecret.push(secretId);
      return { ok: true };
    },
    report: async (regionId) => {
      calls.report.push(regionId);
      return state.reportFailure
        ? { ok: false, message: state.reportFailure }
        : { ok: true, report: state.report ?? [] };
    },
    staleSeats: async (regionId) => {
      calls.staleSeats.push(regionId);
      return { ok: true, seats: state.seats ?? [] };
    },
    restartSeat: async (seatId) => {
      calls.restartSeat.push(seatId);
      const result = state.restart ?? { ok: true };
      if (result.ok) state.seats = (state.seats ?? []).filter((seat) => seat.seatId !== seatId);
      return result;
    },
  };
  return { port, calls, state };
};
