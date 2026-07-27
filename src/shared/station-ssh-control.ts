import { STATION_API_MAX_PROJECTION_CHARS } from "./station-api";

/**
 * OpenSSH local-socket transport constants for the Station API.
 *
 * Envelope schema and ok/err constructors live in `station-api-envelope.ts`.
 * This module is the OpenSSH adapter surface (paths, framing, timeouts) —
 * not a second protocol.
 */
export const STATION_CONTROL_HOME_ENV = "VELLUM_STATION_HOME";
export const STATION_CONTROL_REQUEST_TIMEOUT_MS = 30_000;
export const STATION_CONTROL_MAX_CLIENTS = 8;

// The projection bound dominates every request and report. A JSON document is
// itself encoded as a JSON string on this wire, so reserve worst-case UTF-8
// expansion plus one MiB for the typed envelope while retaining a hard bound.
export const STATION_CONTROL_MAX_FRAME_BYTES =
  STATION_API_MAX_PROJECTION_CHARS * 4 + 1024 * 1024;

export const stationControlDir = (home: string): string =>
  `${home}/.vellum/station`;

export const stationControlSocketPath = (stationHome: string): string =>
  `${stationHome}/control.sock`;

export const encodeStationControlFrame = (value: unknown): string => {
  const encoded = `${JSON.stringify(value)}\n`;
  if (
    new TextEncoder().encode(encoded).byteLength >
      STATION_CONTROL_MAX_FRAME_BYTES
  ) {
    throw new Error(
      `station control frame exceeds ${STATION_CONTROL_MAX_FRAME_BYTES} bytes`,
    );
  }
  return encoded;
};
