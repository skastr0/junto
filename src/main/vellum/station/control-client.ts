import { createConnection } from "node:net";
import { homedir } from "node:os";
import { Either } from "effect";
import {
  decodeStationControlEnvelope,
  decodeStationControlRequest,
  stationControlErr,
  type StationControlEnvelope,
} from "@shared/station-api-envelope";
import {
  STATION_CONTROL_MAX_FRAME_BYTES,
  STATION_CONTROL_HOME_ENV,
  STATION_CONTROL_REQUEST_TIMEOUT_MS,
  encodeStationControlFrame,
  stationControlDir,
  stationControlSocketPath,
} from "@shared/station-ssh-control";

export interface StationControlClientOptions {
  readonly home?: string;
  readonly stationHome?: string;
  readonly socketPath?: string;
  /** Tests may lower the deadline; callers cannot raise the product bound. */
  readonly timeoutMs?: number;
}

export const resolveStationControlSocketPath = (
  options: StationControlClientOptions = {},
): string => {
  if (options.socketPath !== undefined) return options.socketPath;
  const configured =
    options.stationHome?.trim() ||
    process.env[STATION_CONTROL_HOME_ENV]?.trim();
  const stationHome =
    configured && configured.length > 0
      ? configured
      : stationControlDir(options.home ?? homedir());
  return stationControlSocketPath(stationHome);
};

const clientTimeout = (requested: number | undefined): number =>
  requested !== undefined &&
    Number.isFinite(requested) &&
    requested > 0
    ? Math.min(
        Math.floor(requested),
        STATION_CONTROL_REQUEST_TIMEOUT_MS,
      )
    : STATION_CONTROL_REQUEST_TIMEOUT_MS;

const runtimeDown = (error: NodeJS.ErrnoException): boolean =>
  error.code === "ENOENT" ||
  error.code === "ECONNREFUSED" ||
  error.code === "FailedToOpenSocket";

export const sendStationControlRequest = (
  input: unknown,
  options: StationControlClientOptions = {},
): Promise<StationControlEnvelope> => {
  const decodedRequest = decodeStationControlRequest(input);
  if (Either.isLeft(decodedRequest)) {
    return Promise.resolve(
      stationControlErr(
        "protocol_error",
        "station request does not match the API contract",
        false,
      ),
    );
  }

  let frame: string;
  try {
    frame = encodeStationControlFrame(decodedRequest.right);
  } catch {
    return Promise.resolve(
      stationControlErr(
        "protocol_error",
        `station frame exceeds ${STATION_CONTROL_MAX_FRAME_BYTES} bytes`,
        false,
      ),
    );
  }

  const socketPath = resolveStationControlSocketPath(options);
  const timeoutMs = clientTimeout(options.timeoutMs);
  return new Promise((resolve) => {
    const socket = createConnection({ path: socketPath });
    let settled = false;
    const chunks: Buffer[] = [];
    let bufferedBytes = 0;
    const settle = (envelope: StationControlEnvelope): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(envelope);
    };
    const timer = setTimeout(() => {
      settle(
        stationControlErr(
          "unavailable",
          "station control request timed out",
          true,
        ),
      );
    }, timeoutMs);

    socket.once("connect", () => {
      socket.write(frame);
    });
    socket.on("data", (chunk: Buffer | string) => {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const newline = part.indexOf(0x0a);
      const framePart = newline < 0 ? part : part.subarray(0, newline);
      bufferedBytes += framePart.byteLength;
      if (bufferedBytes > STATION_CONTROL_MAX_FRAME_BYTES) {
        settle(
          stationControlErr(
            "internal_error",
            "station control response exceeded its bound",
            false,
          ),
        );
        return;
      }

      chunks.push(framePart);
      if (newline < 0) return;
      if (part.subarray(newline + 1).toString("utf8").trim().length > 0) {
        settle(
          stationControlErr(
            "internal_error",
            "station control returned more than one response",
            false,
          ),
        );
        return;
      }

      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(chunks, bufferedBytes),
        );
        const raw = JSON.parse(text) as unknown;
        const decoded = decodeStationControlEnvelope(raw);
        settle(
          Either.isRight(decoded)
            ? decoded.right
            : stationControlErr(
                "internal_error",
                "station control returned a malformed response",
                false,
              ),
        );
      } catch {
        settle(
          stationControlErr(
            "internal_error",
            "station control returned invalid JSON",
            false,
          ),
        );
      }
    });
    socket.once("end", () => {
      if (!settled) {
        settle(
          stationControlErr(
            "unavailable",
            "station control closed before responding",
            true,
          ),
        );
      }
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      settle(
        runtimeDown(error)
          ? stationControlErr(
              "runtime_down",
              "Vellum Command is not running",
              true,
            )
          : stationControlErr(
              "unavailable",
              "control request failed",
              true,
            ),
      );
    });
  });
};
