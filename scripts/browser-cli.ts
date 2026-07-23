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
  STATION_BROWSER_ORIGIN_ROUTE_PATH,
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
import {
  canonicalStationBrowserJson,
  decodeStationBrowserResponse,
  STATION_BROWSER_MAX_FRAME_BYTES,
  type StationBrowserResponse,
  type StationBrowserSession,
} from "../src/shared/station-browser";
import type { StationBrowserRouteInput } from "../src/main/vellum/browser/station-router";
import {
  installStationBrowserTrustFrame,
  STATION_BROWSER_TRUST_MAX_BYTES,
} from "../src/main/vellum/browser/station-trust";
import { parseNodeRef } from "../src/shared/node-ref";

// Agent CLI for the browser control plane: `bun run browser <cmd>` talks to
// the app-hosted unix-socket server (canvas-ls precedent: plain text by
// default, `--json` for machines). Requires the app running — a dead socket is
// reported as the typed `runtime_down` error, never a stack trace. Exit code
// 0 on ok envelopes, 1 on error envelopes.

const usage = `vellum browser control

usage:
  vellum browser <command> [args] [--json]
  vellum browser --host <station> <command> [args] [--json]
  vellum-browser <command> [args] [--json]
  bun run browser <command> [args] [--json]

auth:
  process-bind only — run as a child of a live Vellum agent (ACP) or herdr pane
  VELLUM_BROWSER_CAPABILITY is ignored for identity (legacy env, unused)
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

cross-station:
  --host is explicit and never inferred
  open returns an opaque station session handle; pass that handle to
  goto, eval, shot, state, close, or stop
  profiles and surface bounds are local-only`;

const STATION_BROWSER_STDIN_TIMEOUT_MS = 5_000;

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
      // Bun's ClientRequest assigns an already-open Unix socket and does not
      // emit its `connect` event to this listener. The transport code is the
      // stable discriminator: absent/stale endpoints mean the runtime is down;
      // a reset after acceptance means the server failed mid-response.
      settle(
        isRuntimeDownTransportError(error)
          ? controlErr("runtime_down", "vellum app is not running")
          : controlErr("failed", "browser control request failed"),
      );
    });
    if (encodedBody !== undefined) req.write(encodedBody);
    req.end();
  });

const readBoundedStdin = (
  limitBytes: number,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeAllListeners("data");
      process.stdin.removeAllListeners("end");
      process.stdin.removeAllListeners("error");
      if (error !== undefined) reject(error);
      else resolve(Buffer.concat(chunks, bytes).toString("utf8"));
    };
    const timer = setTimeout(
      () => finish(new Error("station wrapper stdin timed out")),
      STATION_BROWSER_STDIN_TIMEOUT_MS,
    );
    process.stdin.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > limitBytes) {
        finish(new Error("station wrapper stdin exceeds its byte boundary"));
        process.stdin.destroy();
        return;
      }
      chunks.push(buffer);
    });
    process.stdin.once("end", () => finish());
    process.stdin.once("error", () =>
      finish(new Error("station wrapper stdin could not be read")));
    process.stdin.resume();
  });

const readLocalTransportToken = async (
  home: string,
): Promise<string | undefined> => {
  try {
    return (await readFile(controlTokenPath(home), "utf8")).trim();
  } catch {
    return undefined;
  }
};

const stationWrapperMain = async (
  args: ReadonlyArray<string>,
): Promise<never> => {
  if (args.length !== 0) {
    console.error("station wrapper accepts no arguments");
    process.exit(2);
  }
  try {
    const frame = (await readBoundedStdin(STATION_BROWSER_MAX_FRAME_BYTES)).trim();
    const home = homedir();
    const token = await readLocalTransportToken(home);
    if (token === undefined) throw new Error("target Vellum runtime is unavailable");
    const envelope = await httpOverSocket(
      controlSocketPath(home),
      { method: "POST", path: "/station" },
      token,
      undefined,
      { frame },
    );
    if (
      !envelope.ok ||
      typeof envelope.data !== "object" ||
      envelope.data === null ||
      Array.isArray(envelope.data) ||
      Object.keys(envelope.data).length !== 1 ||
      !("frame" in envelope.data) ||
      typeof envelope.data.frame !== "string"
    ) {
      throw new Error("target Vellum runtime rejected station delegation");
    }
    const response = decodeStationBrowserResponse(envelope.data.frame);
    if (typeof response === "string") {
      throw new Error("target Vellum runtime returned a malformed station response");
    }
    process.stdout.write(`${envelope.data.frame}\n`);
    // A typed denial still crossed the transport successfully. The origin CLI
    // maps response.ok to its own exit semantics after validating host/action.
    process.exit(0);
  } catch {
    console.error("station browser wrapper failed");
    process.exit(1);
  }
};

const stationTrustMain = async (
  args: ReadonlyArray<string>,
): Promise<never> => {
  if (args.length !== 0) {
    console.error("station trust wrapper accepts no arguments");
    process.exit(2);
  }
  try {
    const frame = await readBoundedStdin(STATION_BROWSER_TRUST_MAX_BYTES);
    const response = await installStationBrowserTrustFrame(frame);
    process.stdout.write(`${response}\n`);
    process.exit(0);
  } catch {
    console.error("station trust wrapper failed");
    process.exit(1);
  }
};

interface LocalCall {
  readonly kind: "local";
  readonly route: ControlRouteName;
  readonly body?: unknown;
}

interface StationCall {
  readonly kind: "station";
  readonly hostId: string;
  readonly input: StationBrowserRouteInput;
  /** Retained only to roll an opaque handle after a session response. */
  readonly pageRef?: string;
}

type Call = LocalCall | StationCall;

const STATION_SESSION_HANDLE_PREFIX = "vellum-station-session-v1.";
const STATION_SESSION_HANDLE_MAX_BYTES = 4_096;

interface StationSessionHandle {
  readonly version: 1;
  readonly hostId: string;
  readonly pageRef: string;
  readonly sessionId: string;
  readonly generation: string;
}

const stationId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[A-Za-z0-9._:-]{1,128}$/.test(value);

const encodeStationSessionHandle = (
  pageRef: string,
  session: StationBrowserSession,
): string => {
  const body: StationSessionHandle = {
    version: 1,
    hostId: session.hostId,
    pageRef,
    sessionId: session.sessionId,
    generation: session.generation,
  };
  return `${STATION_SESSION_HANDLE_PREFIX}${Buffer.from(
    canonicalStationBrowserJson(body),
    "utf8",
  ).toString("base64url")}`;
};

const decodeStationSessionHandle = (
  value: string,
): StationSessionHandle | undefined => {
  if (
    Buffer.byteLength(value, "utf8") > STATION_SESSION_HANDLE_MAX_BYTES ||
    !value.startsWith(STATION_SESSION_HANDLE_PREFIX)
  ) {
    return undefined;
  }
  const encoded = value.slice(STATION_SESSION_HANDLE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined;
  try {
    const wire = Buffer.from(encoded, "base64url").toString("utf8");
    const decoded = JSON.parse(wire) as unknown;
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      Array.isArray(decoded) ||
      Object.keys(decoded).length !== 5 ||
      !("version" in decoded) ||
      decoded.version !== 1 ||
      !("hostId" in decoded) ||
      !stationId(decoded.hostId) ||
      !("pageRef" in decoded) ||
      typeof decoded.pageRef !== "string" ||
      !parseNodeRef(decoded.pageRef).ok ||
      !("sessionId" in decoded) ||
      !stationId(decoded.sessionId) ||
      !("generation" in decoded) ||
      !stationId(decoded.generation)
    ) {
      return undefined;
    }
    const handle = decoded as unknown as StationSessionHandle;
    return encodeStationSessionHandle(handle.pageRef, {
      hostId: handle.hostId,
      sessionId: handle.sessionId,
      generation: handle.generation,
    }) === value
      ? handle
      : undefined;
  } catch {
    return undefined;
  }
};

const stationCall = (
  hostId: string,
  positional: ReadonlyArray<string>,
): StationCall | { readonly error: string } => {
  const [cmd, a, b, extra] = positional;
  if (cmd === "profiles") {
    return { error: "profiles is local-only; Remote profile metadata is not delegated" };
  }
  if (cmd === "doctor" || cmd === "pages" || cmd === "sessions") {
    if (a !== undefined) return { error: `${cmd} accepts no arguments` };
    return {
      kind: "station",
      hostId,
      input: {
        action:
          cmd === "pages"
            ? "discover"
            : cmd === "sessions"
              ? "list"
              : "doctor",
        targetHostId: hostId,
      },
    };
  }
  if (cmd === "open") {
    if (!a || b !== undefined || !parseNodeRef(a).ok) {
      return { error: "open requires exactly one canonical <vellum-ref>" };
    }
    return {
      kind: "station",
      hostId,
      input: {
        action: "open",
        pageRef: a,
        targetHostId: hostId,
      },
      pageRef: a,
    };
  }
  if (
    cmd !== "goto" &&
    cmd !== "eval" &&
    cmd !== "shot" &&
    cmd !== "screenshot" &&
    cmd !== "state" &&
    cmd !== "close" &&
    cmd !== "stop"
  ) {
    return { error: usage };
  }
  const handle = a === undefined
    ? undefined
    : decodeStationSessionHandle(a);
  if (handle === undefined || handle.hostId !== hostId) {
    return {
      error:
        `${cmd} requires an opaque session handle returned by open on host ${hostId}`,
    };
  }
  if (
    (cmd === "goto" || cmd === "eval")
      ? b === undefined || extra !== undefined
      : b !== undefined
  ) {
    return {
      error:
        cmd === "goto"
          ? "goto requires <station-session-handle> <url>"
          : cmd === "eval"
            ? "eval requires <station-session-handle> <code>"
            : `${cmd} requires exactly one <station-session-handle>`,
    };
  }
  const action = cmd === "shot" ? "screenshot" : cmd;
  return {
    kind: "station",
    hostId,
    input: {
      action,
      pageRef: handle.pageRef,
      session: {
        hostId: handle.hostId,
        sessionId: handle.sessionId,
        generation: handle.generation,
      },
      ...(action === "goto"
        ? { payload: { url: b! } }
        : action === "eval"
          ? { payload: { code: b! } }
          : {}),
      targetHostId: hostId,
    },
    pageRef: handle.pageRef,
  };
};

const parseArgs = (
  argv: ReadonlyArray<string>,
): { call: Call; json: boolean } | { error: string } => {
  // The packaged executable is installed under both names. `vellum-browser`
  // receives the command directly; `vellum browser` reaches the same binary
  // through a symlink and contributes the one dispatch word below.
  let commandArgv = argv[0] === "browser" ? argv.slice(1) : [...argv];
  const json = commandArgv.includes("--json");
  commandArgv = commandArgv.filter((value) => value !== "--json");
  if (commandArgv.includes("--path")) return { error: "shot does not accept --path; Vellum owns screenshot destinations" };
  let hostId: string | undefined;
  if (commandArgv[0] === "--host") {
    if (!stationId(commandArgv[1])) {
      return { error: "--host requires one canonical station id" };
    }
    hostId = commandArgv[1];
    commandArgv = commandArgv.slice(2);
  } else if (commandArgv.includes("--host")) {
    return { error: "--host must precede the browser command" };
  }
  if (hostId !== undefined) {
    const call = stationCall(hostId, commandArgv);
    return "error" in call ? call : { json, call };
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

const stationResponseFromEnvelope = (
  envelope: ControlEnvelope<unknown>,
  call: StationCall,
): StationBrowserResponse | undefined => {
  if (
    !envelope.ok ||
    typeof envelope.data !== "object" ||
    envelope.data === null ||
    Array.isArray(envelope.data) ||
    Object.keys(envelope.data).length !== 1 ||
    !("response" in envelope.data)
  ) {
    return undefined;
  }
  let wire: string;
  try {
    wire = canonicalStationBrowserJson(envelope.data.response);
  } catch {
    return undefined;
  }
  const response = decodeStationBrowserResponse(wire);
  return typeof response !== "string" &&
      response.hostId === call.hostId &&
      response.action === call.input.action
    ? response
    : undefined;
};

const projectStationResponse = (
  response: Extract<StationBrowserResponse, { readonly ok: true }>,
  call: StationCall,
): unknown => {
  if (
    call.pageRef !== undefined &&
    typeof response.data === "object" &&
    response.data !== null &&
    !Array.isArray(response.data) &&
    "session" in response.data
  ) {
    const session = response.data.session as StationBrowserSession;
    if (
      session.hostId !== call.hostId ||
      !stationId(session.sessionId) ||
      !stationId(session.generation)
    ) {
      return undefined;
    }
    return {
      hostId: session.hostId,
      sessionHandle: encodeStationSessionHandle(call.pageRef, session),
    };
  }
  return response.data;
};

const printStationDeniedAndExit = (
  response: Extract<StationBrowserResponse, { readonly ok: false }>,
  json: boolean,
): never => {
  if (json) {
    console.log(JSON.stringify({
      ok: false,
      error: {
        _tag: "forbidden",
        message: "station browser request was denied",
      },
      station: {
        hostId: response.hostId,
        action: response.action,
        denial: response.error,
      },
    }));
  } else {
    console.error(
      `forbidden: station ${response.hostId} denied ${response.action} (${response.error})`,
    );
  }
  process.exit(1);
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

/**
 * Product path is process-bind only. Capability env is no longer identity —
 * the server attributes this process via Unix peer PID. We still parse a
 * malformed capability env as InputError so agents notice stale ceremony config.
 */
const admissionFor = (
  route: ControlRouteName,
): { readonly capability?: string } | ControlErr => {
  if (route === "doctor") return {};
  const capability = process.env[CONTROL_CAPABILITY_ENV];
  if (capability === undefined) return {};
  // Present but malformed — tell the operator the env is stale/wrong.
  // Valid secrets are not sent: product HTTP path ignores them for identity.
  if (!isValidControlCapability(capability)) {
    return controlErr(
      "unauthorized",
      `${CONTROL_CAPABILITY_ENV} is set but malformed — unset it; identity is process-bind`,
    );
  }
  return {};
};

const main = async (): Promise<void> => {
  const rawArgv = process.argv.slice(2);
  if (rawArgv[0] === "station") {
    return stationWrapperMain(rawArgv.slice(1));
  }
  if (rawArgv[0] === "station-trust") {
    return stationTrustMain(rawArgv.slice(1));
  }
  const parsed = parseArgs(rawArgv);
  if ("error" in parsed) {
    console.error(parsed.error);
    process.exit(2);
  }

  const resolvedHome = controlHome();
  if (typeof resolvedHome !== "string") return printErrorAndExit(resolvedHome, parsed.json);
  const home = resolvedHome;

  const admission = admissionFor(
    parsed.call.kind === "local" ? parsed.call.route : "pages",
  );
  if ("error" in admission) {
    return printErrorAndExit(admission, parsed.json);
  }
  const capability = admission.capability;

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
    parsed.call.kind === "local"
      ? CONTROL_ROUTES[parsed.call.route]
      : { method: "POST", path: STATION_BROWSER_ORIGIN_ROUTE_PATH },
    token,
    capability,
    parsed.call.kind === "local"
      ? parsed.call.body
      : parsed.call.input,
  );

  if (parsed.call.kind === "station") {
    if (!envelope.ok) {
      return printErrorAndExit(envelope, parsed.json);
    }
    const response = stationResponseFromEnvelope(envelope, parsed.call);
    if (response === undefined) {
      return printErrorAndExit(
        controlErr("failed", "server returned a malformed station response"),
        parsed.json,
      );
    }
    if (!response.ok) {
      return printStationDeniedAndExit(response, parsed.json);
    }
    const projected = projectStationResponse(response, parsed.call);
    if (projected === undefined) {
      return printErrorAndExit(
        controlErr("failed", "server returned a mismatched station session"),
        parsed.json,
      );
    }
    if (parsed.json) {
      console.log(JSON.stringify({ ok: true, data: projected }));
      process.exit(0);
    }
    printHuman(
      parsed.call.input.action === "eval" ? "eval" : "pages",
      projected,
    );
    return;
  }

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
