import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { homedir } from "node:os";
import { isAbsolute, normalize } from "node:path";
import { Effect, Result } from "effect";
import {
  CONTROL_HOME_ENV,
  CONTROL_REQUEST_ID_HEADER,
  CONTROL_ROUTES,
  CONTROL_TOKEN_HEADER,
  controlErr,
  controlSocketPath,
  controlTokenPath,
  decodeControlEnvelope,
  isValidControlRequestId,
  type ControlEnvelope,
  type ControlRouteName,
} from "../../shared/browser-control";
import {
  BROWSER_CLI_REQUEST_TIMEOUT_MS,
  BROWSER_CONTROL_MAX_REQUEST_BODY_BYTES,
  BROWSER_CONTROL_MAX_RESPONSE_BYTES,
} from "../../shared/browser-limits";
import { browserWireError } from "./browser-errors";
import { WireError } from "./errors";

/**
 * The browser control plane as `junto browser` speaks it: HTTP over the
 * app-hosted unix socket, carrying the owner-local transport token. The
 * server admits the calling process through its navigates edge grant; this
 * side holds no capability secret. A dead socket is the typed RuntimeDown.
 */

// Bounds the whole round trip, so a page script that never resolves cannot
// hang the CLI without a typed error.
const requestTimeoutMs = (): number => {
  const configured = process.env.JUNTO_BROWSER_REQUEST_TIMEOUT_MS;
  if (configured === undefined || !/^[1-9][0-9]*$/.test(configured)) {
    return BROWSER_CLI_REQUEST_TIMEOUT_MS;
  }
  const parsed = Number(configured);
  return Number.isSafeInteger(parsed)
    ? Math.min(parsed, BROWSER_CLI_REQUEST_TIMEOUT_MS)
    : BROWSER_CLI_REQUEST_TIMEOUT_MS;
};

const isRuntimeDownTransportError = (error: NodeJS.ErrnoException): boolean =>
  error.code === "ENOENT" ||
  error.code === "ECONNREFUSED" ||
  // Bun reports both an absent Unix socket and a retained socket inode with
  // no listener using this runtime-specific code, including in compiled CLIs.
  error.code === "FailedToOpenSocket";

const httpOverSocket = (
  socketPath: string,
  route: { method: string; path: string },
  token: string,
  body: unknown,
): Promise<ControlEnvelope<unknown>> =>
  new Promise((resolve) => {
    let encodedBody: string | undefined;
    if (body !== undefined) {
      encodedBody = JSON.stringify(body);
      if (Buffer.byteLength(encodedBody) > BROWSER_CONTROL_MAX_REQUEST_BODY_BYTES) {
        resolve(
          controlErr(
            "bad_request",
            `request body exceeds ${BROWSER_CONTROL_MAX_REQUEST_BODY_BYTES} bytes`,
          ),
        );
        return;
      }
    }

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (envelope: ControlEnvelope<unknown>): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(envelope);
    };
    const requestId = randomUUID();
    if (!isValidControlRequestId(requestId)) {
      settle(controlErr("failed", "could not create a valid request id"));
      return;
    }
    const req = request(
      {
        socketPath,
        path: route.path,
        method: route.method,
        headers: {
          "content-type": "application/json",
          [CONTROL_TOKEN_HEADER]: token,
          [CONTROL_REQUEST_ID_HEADER]: requestId,
          ...(encodedBody === undefined
            ? {}
            : { "content-length": String(Buffer.byteLength(encodedBody)) }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let responseBytes = 0;
        const declaredLength = res.headers["content-length"];
        if (
          typeof declaredLength === "string" &&
          /^(0|[1-9][0-9]*)$/.test(declaredLength) &&
          Number(declaredLength) > BROWSER_CONTROL_MAX_RESPONSE_BYTES
        ) {
          settle(
            controlErr(
              "result_too_large",
              `server response exceeds ${BROWSER_CONTROL_MAX_RESPONSE_BYTES} bytes`,
            ),
          );
          res.destroy();
          req.destroy();
          return;
        }
        const failIncomplete = (): void => {
          if (!res.complete) settle(controlErr("failed", "server response closed before completion"));
        };
        res.once("aborted", failIncomplete);
        res.once("error", () => settle(controlErr("failed", "server response could not be read")));
        res.once("close", failIncomplete);
        res.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          responseBytes += buffer.byteLength;
          if (responseBytes > BROWSER_CONTROL_MAX_RESPONSE_BYTES) {
            settle(
              controlErr(
                "result_too_large",
                `server response exceeds ${BROWSER_CONTROL_MAX_RESPONSE_BYTES} bytes`,
              ),
            );
            res.destroy();
            req.destroy();
            return;
          }
          chunks.push(buffer);
        });
        res.on("end", () => {
          if (settled) return;
          try {
            const decoded = decodeControlEnvelope(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            settle(
              Result.isFailure(decoded)
                ? controlErr("failed", "server returned a malformed envelope")
                : decoded.success,
            );
          } catch {
            settle(controlErr("failed", "server returned non-JSON"));
          }
        });
      },
    );
    const timeoutMs = requestTimeoutMs();
    timer = setTimeout(() => {
      settle(controlErr("timeout", `request timed out after ${timeoutMs}ms`));
      req.destroy();
    }, timeoutMs);
    req.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      // Bun's ClientRequest assigns an already-open Unix socket and does not
      // emit its `connect` event to this listener. The transport code is the
      // stable discriminator: absent/stale endpoints mean the runtime is down;
      // a reset after acceptance means the server failed mid-response.
      settle(
        isRuntimeDownTransportError(error)
          ? controlErr("runtime_down", "Junto app is not running")
          : controlErr("failed", "browser control request failed"),
      );
    });
    if (encodedBody !== undefined) req.write(encodedBody);
    req.end();
  });

const controlHome = (): Result.Result<string, WireError> => {
  const configured = process.env[CONTROL_HOME_ENV];
  if (configured === undefined) return Result.succeed(homedir());
  if (
    configured.length === 0 ||
    Buffer.byteLength(configured) > 4_096 ||
    /[\u0000-\u001f\u007f]/.test(configured) ||
    !isAbsolute(configured)
  ) {
    return Result.fail(
      new WireError({
        type: "InputError",
        message: `${CONTROL_HOME_ENV} must be a bounded absolute path without control characters`,
        details: { reason: "bad_request", retryable: false },
      }),
    );
  }
  return Result.succeed(normalize(configured));
};

/** One control route, its data on success and a WireError otherwise. */
export const callBrowserControl = (
  route: ControlRouteName,
  body?: unknown,
): Effect.Effect<unknown, WireError> =>
  Effect.gen(function* () {
    const home = yield* Effect.fromResult(controlHome());
    const token = yield* Effect.tryPromise({
      try: async () => (await readFile(controlTokenPath(home), "utf8")).trim(),
      // No token file: the app has never started its control plane.
      catch: () =>
        browserWireError(controlErr("runtime_down", "control token unavailable, is the app running?").error),
    });
    const envelope = yield* Effect.tryPromise({
      try: () => httpOverSocket(controlSocketPath(home), CONTROL_ROUTES[route], token, body),
      // A request that throws before it is sent is a failed call, not a defect.
      catch: () => browserWireError(controlErr("failed", "browser control request failed").error),
    });
    return envelope.ok ? envelope.data : yield* Effect.fail(browserWireError(envelope.error));
  });
