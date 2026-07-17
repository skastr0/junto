#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { homedir } from "node:os";
import { isAbsolute, normalize } from "node:path";
import {
  CONTROL_CAPABILITY_ENV,
  CONTROL_CAPABILITY_HEADER,
  CONTROL_HOME_ENV,
  CONTROL_REQUEST_ID_HEADER,
  CONTROL_ROUTES,
  CONTROL_TOKEN_HEADER,
  controlErr,
  controlSocketPath,
  controlTokenPath,
  decodeControlEnvelope,
  isValidControlCapability,
  isValidControlRequestId,
  type ControlErr,
  type ControlEnvelope,
  type ControlRouteName,
} from "../src/shared/browser-control";
import { Either } from "effect";
import {
  BROWSER_CLI_REQUEST_TIMEOUT_MS,
  BROWSER_CONTROL_MAX_REQUEST_BODY_BYTES,
  BROWSER_CONTROL_MAX_RESPONSE_BYTES,
} from "../src/shared/browser-limits";

// Agent CLI for the browser control plane: `bun run browser <cmd>` talks to
// the app-hosted unix-socket server (canvas-ls precedent: plain text by
// default, `--json` for machines). Requires the app running — a dead socket is
// reported as the typed `runtime_down` error, never a stack trace. Exit code
// 0 on ok envelopes, 1 on error envelopes.

const usage = `vellum browser control

usage:
  vellum browser <command> [args] [--json]
  vellum-browser <command> [args] [--json]
  bun run browser <command> [args] [--json]

commands:
  doctor                          control plane health (app must be running)
  profiles                        list browser profiles
  pages                           list page nodes across canvases
  sessions                        list live sessions
  open <vellum-ref>                resolve and open/reuse a page session
  goto <sessionId> <url>           navigate an existing session
  eval <sessionId> <code>          run JS in the page, print JSON result
  shot <sessionId>                 screenshot to a server-owned PNG
  close <sessionId>                detach the surface (session stays warm)`;

// Bounds the whole request/response round-trip. Without this, a hung page
// script (executeJavaScript that never resolves — e.g. `while(true){}` run
// through `eval`) wedges the HTTP handler forever and the CLI hangs with no
// typed error, contradicting the runtime_down contract this file documents.
const requestTimeoutMs = (): number => {
  const configured = process.env.VELLUM_BROWSER_REQUEST_TIMEOUT_MS;
  if (configured === undefined || !/^[1-9][0-9]*$/.test(configured)) {
    return BROWSER_CLI_REQUEST_TIMEOUT_MS;
  }
  const parsed = Number(configured);
  return Number.isSafeInteger(parsed)
    ? Math.min(parsed, BROWSER_CLI_REQUEST_TIMEOUT_MS)
    : BROWSER_CLI_REQUEST_TIMEOUT_MS;
};

const httpOverSocket = (
  socketPath: string,
  route: { method: string; path: string },
  token: string,
  capability: string | undefined,
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
          ...(capability === undefined
            ? {}
            : { [CONTROL_CAPABILITY_HEADER]: capability }),
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
              Either.isLeft(decoded)
                ? controlErr("failed", "server returned a malformed envelope")
                : decoded.right,
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
      // Socket missing (never started) or refusing (crashed): the app is down.
      settle(
        error.code === "ENOENT" || error.code === "ECONNREFUSED"
          ? controlErr("runtime_down", `vellum app is not running (${error.code} on ${socketPath})`)
          : controlErr("failed", error.message),
      );
    });
    if (encodedBody !== undefined) req.write(encodedBody);
    req.end();
  });

interface Call {
  readonly route: ControlRouteName;
  readonly body?: unknown;
}

const parseArgs = (
  argv: ReadonlyArray<string>,
): { call: Call; json: boolean } | { error: string } => {
  // The packaged executable is installed under both names. `vellum-browser`
  // receives the command directly; `vellum browser` reaches the same binary
  // through a symlink and contributes the one dispatch word below.
  const commandArgv = argv[0] === "browser" ? argv.slice(1) : argv;
  const json = commandArgv.includes("--json");
  if (commandArgv.includes("--path")) return { error: "shot does not accept --path; Vellum owns screenshot destinations" };
  const positional = commandArgv.filter((value) => value !== "--json");
  const [cmd, a, b] = positional;

  switch (cmd) {
    case "doctor":
    case "profiles":
    case "pages":
    case "sessions":
      return { json, call: { route: cmd } };
    case "open":
      if (!a || b) return { error: "open requires exactly one <vellum-ref>" };
      return {
        json,
        call: {
          route: "open",
          body: { ref: a },
        },
      };
    case "goto":
      if (!a || !b) return { error: "goto requires <sessionId> <url>" };
      return { json, call: { route: "goto", body: { sessionId: a, url: b } } };
    case "eval":
      if (!a || !b) return { error: "eval requires <sessionId> <code>" };
      return { json, call: { route: "eval", body: { sessionId: a, code: b } } };
    case "shot":
    case "screenshot":
      if (!a) return { error: "shot requires <sessionId>" };
      return {
        json,
        call: { route: "screenshot", body: { sessionId: a } },
      };
    case "close":
      if (!a) return { error: "close requires <sessionId>" };
      return { json, call: { route: "close", body: { sessionId: a } } };
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

const capabilityFor = (
  route: ControlRouteName,
): string | undefined | ControlErr => {
  // Doctor is transport-authenticated liveness only. Never attach a browser
  // authority secret to a route that does not need one.
  if (route === "doctor") return undefined;
  const capability = process.env[CONTROL_CAPABILITY_ENV];
  if (capability === undefined || !isValidControlCapability(capability)) {
    return controlErr(
      "unauthorized",
      `${CONTROL_CAPABILITY_ENV} is required for protected browser commands`,
    );
  }
  return capability;
};

const main = async (): Promise<void> => {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(parsed.error);
    process.exit(2);
  }

  const resolvedHome = controlHome();
  if (typeof resolvedHome !== "string") return printErrorAndExit(resolvedHome, parsed.json);
  const home = resolvedHome;

  const resolvedCapability = capabilityFor(parsed.call.route);
  if (typeof resolvedCapability === "object") {
    return printErrorAndExit(resolvedCapability, parsed.json);
  }
  const capability = resolvedCapability;

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
    capability,
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

await main();
