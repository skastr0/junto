#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { homedir } from "node:os";
import { isAbsolute, normalize } from "node:path";
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
  type ControlErr,
  type ControlEnvelope,
  type ControlRouteName,
} from "../src/shared/browser-control";
import { Result } from "effect";
import {
  BROWSER_CLI_REQUEST_TIMEOUT_MS,
  BROWSER_CONTROL_MAX_REQUEST_BODY_BYTES,
  BROWSER_CONTROL_MAX_RESPONSE_BYTES,
} from "../src/shared/browser-limits";
import { BROWSER_ENABLED } from "../src/shared/features";

// Agent CLI for the browser control plane: `bun run browser <cmd>` talks to
// the app-hosted unix-socket server (canvas-ls precedent: plain text by
// default, `--json` for machines). Requires the app running — a dead socket is
// reported as the typed `runtime_down` error, never a stack trace. Exit code
// 0 on ok envelopes, 1 on error envelopes. Remote Station-browser is deleted;
// `--host`, hidden `station` mode, and station-trust exit 2 before transport.

const usage = `vellum-command browser control

usage:
  vellum-command browser <command> [args] [--json]
  vellum-command-browser <command> [args] [--json]
  bun run browser <command> [args] [--json]

auth:
  process-bind only — run as a child of a live Junto agent (ACP)
  doctor needs only the owner-local transport token

commands:
  doctor                          control plane health (app must be running)
  profiles                        list browser profiles
  pages                           list page nodes across canvases
  sessions                        list live sessions
  open <vellum-ref>                resolve and open/reuse a page session
  goto <sessionId> <url>           navigate an existing session
  eval <sessionId> <code>          run JS in the page, print JSON result
  shot <sessionId>                 screenshot to a server-owned PNG
  close <sessionId>                detach the surface (session stays warm)
  stop <sessionId>                 destroy the page runtime (profile stays)

host-local only:
  remote Station-browser (--host / station / station-trust) is removed`;

// Bounds the whole request/response round-trip. Without this, a hung page
// script (executeJavaScript that never resolves — e.g. `while(true){}` run
// through `eval`) wedges the HTTP handler forever and the CLI hangs with no
// typed error, contradicting the runtime_down contract this file documents.
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
      try {
        encodedBody = JSON.stringify(body);
      } catch {
        resolve(controlErr("bad_request", "request body is not supported by JSON"));
        return;
      }
      if (encodedBody === undefined) {
        resolve(controlErr("bad_request", "request body is not supported by JSON"));
        return;
      }
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

interface LocalCall {
  readonly kind: "local";
  readonly route: ControlRouteName;
  readonly body?: unknown;
}

type Call = LocalCall;

const parseArgs = (
  argv: ReadonlyArray<string>,
): { call: Call; json: boolean } | { error: string } => {
  // The standalone compatibility helper receives the command directly. The
  // canonical `vellum-command browser` dispatcher calls this same parser and may leave
  // its one dispatch word in argv.
  let commandArgv = argv[0] === "browser" ? argv.slice(1) : [...argv];
  const json = commandArgv.includes("--json");
  commandArgv = commandArgv.filter((value) => value !== "--json");
  if (commandArgv.includes("--path")) {
    return { error: "shot does not accept --path; Junto owns screenshot destinations" };
  }
  // Retired remote Station-browser surface: exit before token/socket/network.
  if (
    commandArgv[0] === "station" ||
    commandArgv[0] === "station-trust" ||
    commandArgv.includes("station-trust") ||
    commandArgv.includes("--host") ||
    commandArgv[0] === "--host"
  ) {
    return {
      error:
        "remote Station-browser is removed; use host-local browser commands without --host/station/station-trust",
    };
  }
  const [cmd, a, b, extra] = commandArgv;

  switch (cmd) {
    case "doctor":
    case "profiles":
    case "pages":
    case "sessions":
      if (a !== undefined) return { error: `${cmd} accepts no arguments` };
      return { json, call: { kind: "local", route: cmd } };
    case "open":
      if (!a || b) return { error: "open requires exactly one <vellum-ref>" };
      return {
        json,
        call: {
          kind: "local",
          route: "open",
          body: { ref: a },
        },
      };
    case "goto":
      if (!a || !b || extra !== undefined) return { error: "goto requires <sessionId> <url>" };
      return { json, call: { kind: "local", route: "goto", body: { sessionId: a, url: b } } };
    case "eval":
      if (!a || !b || extra !== undefined) return { error: "eval requires <sessionId> <code>" };
      return { json, call: { kind: "local", route: "eval", body: { sessionId: a, code: b } } };
    case "shot":
    case "screenshot":
      if (!a || b !== undefined) return { error: "shot requires exactly one <sessionId>" };
      return {
        json,
        call: { kind: "local", route: "screenshot", body: { sessionId: a } },
      };
    case "close":
      if (!a || b) return { error: "close requires exactly one <sessionId>" };
      return { json, call: { kind: "local", route: "close", body: { sessionId: a } } };
    case "stop":
      if (!a || b) return { error: "stop requires exactly one <sessionId>" };
      return { json, call: { kind: "local", route: "stop", body: { sessionId: a } } };
    default:
      return { error: usage };
  }
};

const printHuman = (route: ControlRouteName, data: unknown): void => {
  if (route === "eval") {
    console.log(JSON.stringify((data as { result: unknown }).result, null, 2));
    return;
  }
  if (Array.isArray(data)) {
    if (data.length === 0) console.log("(none)");
    for (const row of data) console.log(JSON.stringify(row));
    return;
  }
  console.log(JSON.stringify(data, null, 2));
};

const printErrorAndExit = (envelope: ControlErr, json: boolean): never => {
  if (json) {
    console.log(JSON.stringify(envelope));
  } else {
    console.error(`${envelope.error._tag}: ${envelope.error.message}`);
  }
  process.exit(1);
};

const controlHome = (): string | ControlErr => {
  const configured = process.env[CONTROL_HOME_ENV];
  if (configured === undefined) return homedir();
  if (
    configured.length === 0 ||
    Buffer.byteLength(configured) > 4_096 ||
    /[\u0000-\u001f\u007f]/.test(configured) ||
    !isAbsolute(configured)
  ) {
    return controlErr(
      "bad_request",
      `${CONTROL_HOME_ENV} must be a bounded absolute path without control characters`,
    );
  }
  return normalize(configured);
};

export const runBrowserCli = async (
  rawArgv: ReadonlyArray<string> = process.argv.slice(2),
): Promise<void> => {
  if (!BROWSER_ENABLED) {
    console.error("Browser is disabled in this Junto build");
    process.exit(2);
  }
  // Hidden station wrapper and station-trust exit before any transport.
  if (rawArgv[0] === "station" || rawArgv[0] === "station-trust") {
    console.error(
      "remote Station-browser is removed; use host-local browser commands without --host/station/station-trust",
    );
    process.exit(2);
  }
  const parsed = parseArgs(rawArgv);
  if ("error" in parsed) {
    console.error(parsed.error);
    process.exit(2);
  }

  const resolvedHome = controlHome();
  if (typeof resolvedHome !== "string") return printErrorAndExit(resolvedHome, parsed.json);
  const home = resolvedHome;

  let token: string | undefined;
  try {
    token = (await readFile(controlTokenPath(home), "utf8")).trim();
  } catch {
    // No token file → the app has never started its control plane. Route
    // through the same human/json branching as every other error below, so
    // this runtime_down looks identical to the socket-level one regardless of
    // which path detected it.
    printErrorAndExit(
      controlErr("runtime_down", `control token unavailable — is the app running?`),
      parsed.json,
    );
  }
  if (token === undefined) return;

  const envelope = await httpOverSocket(
    controlSocketPath(home),
    CONTROL_ROUTES[parsed.call.route],
    token,
    parsed.call.body,
  );

  if (parsed.json) {
    console.log(JSON.stringify(envelope));
    process.exit(envelope.ok ? 0 : 1);
  }

  if (!envelope.ok) {
    console.error(`${envelope.error._tag}: ${envelope.error.message}`);
    process.exit(1);
  }
  printHuman(parsed.call.route, envelope.data);
};

if (import.meta.main) {
  await runBrowserCli();
}
