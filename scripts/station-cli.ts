#!/usr/bin/env bun
import {
  STATION_CONTROL_MAX_FRAME_BYTES,
  stationControlErr,
} from "../src/shared/station-control";
import { sendStationControlRequest } from "../src/main/vellum/station/control-client";

const write = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const readRequest = (): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.removeListener("error", onError);
      if (error !== undefined) {
        reject(error);
        return;
      }
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(chunks, bytes),
        );
        resolve(JSON.parse(text) as unknown);
      } catch {
        reject(new Error("stdin must contain one UTF-8 JSON request"));
      }
    };
    const onData = (chunk: Buffer | string): void => {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += part.byteLength;
      if (bytes > STATION_CONTROL_MAX_FRAME_BYTES) {
        finish(
          new Error(
            `stdin exceeds ${STATION_CONTROL_MAX_FRAME_BYTES} bytes`,
          ),
        );
        return;
      }
      chunks.push(part);
    };
    const onEnd = (): void => finish();
    const onError = (): void =>
      finish(new Error("stdin could not be read"));
    const timer = setTimeout(
      () => finish(new Error("stdin request timed out")),
      30_000,
    );
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onError);
    process.stdin.resume();
  });

const main = async (): Promise<void> => {
  if (process.argv.slice(2).length > 0) {
    write(
      stationControlErr(
        "protocol_error",
        "vellum-station accepts one JSON request on stdin and no arguments",
        false,
      ),
    );
    process.exitCode = 1;
    return;
  }

  try {
    const request = await readRequest();
    const response = await sendStationControlRequest(request);
    write(response);
    process.exitCode = response.ok ? 0 : 1;
  } catch (error) {
    write(
      stationControlErr(
        "protocol_error",
        error instanceof Error
          ? error.message
          : "station request could not be read",
        false,
      ),
    );
    process.exitCode = 1;
  }
};

await main();
