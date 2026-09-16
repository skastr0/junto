import { createConnection, type Socket } from "node:net";
import { resolveJuntoHome } from "@shared/junto-home";
import type { StationDoor } from "@shared/station-mode";
import {
  STATION_CONTROL_HOME_ENV,
  stationControlDir,
  stationDoorSocketPath,
} from "@shared/station-ssh-control";

export interface StationControlRelayOptions {
  readonly home?: string;
  readonly stationHome?: string;
  readonly door: StationDoor;
}

export interface StationControlRelayStreams {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
}

export const resolveStationControlSocketPath = (
  options: StationControlRelayOptions,
): string => {
  const configured =
    options.stationHome?.trim() ||
    process.env[STATION_CONTROL_HOME_ENV]?.trim();
  const stationHome =
    configured && configured.length > 0
      ? configured
      : stationControlDir(options.home ?? resolveJuntoHome());
  return stationDoorSocketPath(stationHome, options.door);
};

/**
 * Relay bytes between one stdio-shaped duplex stream and the owner-local
 * Station control socket.
 *
 * This adapter deliberately has no Station protocol imports. It never parses,
 * buffers, correlates, or interprets frames; Node's stream piping supplies
 * transport backpressure in both directions.
 */
export const relayStationControlSession = (
  options: StationControlRelayOptions,
  streams: StationControlRelayStreams = {
    input: process.stdin,
    output: process.stdout,
  },
): Promise<void> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({
      path: resolveStationControlSocketPath(options),
    });
    let settled = false;

    const cleanup = (): void => {
      streams.input.unpipe(socket);
      socket.unpipe(streams.output);
      streams.input.off("error", onInputError);
      streams.output.off("error", onOutputError);
      socket.off("error", onSocketError);
      socket.off("close", onSocketClose);
    };
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error !== undefined) {
        socket.destroy();
        reject(error);
        return;
      }
      resolve();
    };
    const onInputError = (): void =>
      settle(new Error("station relay input failed"));
    const onOutputError = (): void =>
      settle(new Error("station relay output failed"));
    const onSocketError = (): void =>
      settle(new Error("station relay connection failed"));
    const onSocketClose = (hadError: boolean): void => {
      if (hadError) {
        settle(new Error("station relay connection failed"));
        return;
      }
      settle();
    };

    streams.input.once("error", onInputError);
    streams.output.once("error", onOutputError);
    socket.once("error", onSocketError);
    socket.once("close", onSocketClose);
    socket.once("connect", () => {
      streams.input.pipe(socket);
      socket.pipe(streams.output, { end: false });
    });
  });
