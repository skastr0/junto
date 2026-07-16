#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { homedir } from "node:os";
import {
  CONTROL_ROUTES,
  CONTROL_TOKEN_HEADER,
  controlErr,
  controlSocketPath,
  controlTokenPath,
  decodeControlEnvelope,
  type ControlEnvelope,
  type ControlRouteName,
} from "../src/shared/browser-control";
import { Either } from "effect";

// Agent CLI for the browser control plane: `bun run browser <cmd>` talks to
// the app-hosted unix-socket server (canvas-ls precedent: plain text by
// default, `--json` for machines). Requires the app running — a dead socket is
// reported as the typed `runtime_down` error, never a stack trace. Exit code
// 0 on ok envelopes, 1 on error envelopes.

const usage = `vellum browser control

usage: bun run browser <command> [args] [--json]

commands:
  doctor                          control plane health (app must be running)
  profiles                        list browser profiles
  pages                           list page nodes across canvases
  sessions                        list live sessions
  open <nodeId> <url> [--profile <id>]   open/reuse a warm session
  goto <nodeId> <url>             navigate an existing session
  eval <nodeId> <code>            run JS in the page, print JSON result
  shot <nodeId> [--path <abs.png>]        screenshot to PNG
  close <nodeId>                  detach the surface (session stays warm)`;

// Bounds the whole request/response round-trip. Without this, a hung page
// script (executeJavaScript that never resolves — e.g. `while(true){}` run
// through `eval`) wedges the HTTP handler forever and the CLI hangs with no
// typed error, contradicting the runtime_down contract this file documents.
const REQUEST_TIMEOUT_MS = 30_000;

const httpOverSocket = (
  socketPath: string,
  route: { method: string; path: string },
  token: string,
  body: unknown,
): Promise<ControlEnvelope<unknown>> =>
  new Promise((resolve) => {
    const req = request(
      {
        socketPath,
        path: route.path,
        method: route.method,
        headers: {
          "content-type": "application/json",
          [CONTROL_TOKEN_HEADER]: token,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            const decoded = decodeControlEnvelope(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            resolve(
              Either.isLeft(decoded)
                ? controlErr("failed", "server returned a malformed envelope")
                : decoded.right,
            );
          } catch {
            resolve(controlErr("failed", "server returned non-JSON"));
          }
        });
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`request timed out after ${REQUEST_TIMEOUT_MS}ms — the app may be hung`));
    });
    req.on("error", (error: NodeJS.ErrnoException) => {
      // Socket missing (never started) or refusing (crashed): the app is down.
      resolve(
        error.code === "ENOENT" || error.code === "ECONNREFUSED"
          ? controlErr("runtime_down", `vellum app is not running (${error.code} on ${socketPath})`)
          : controlErr("failed", error.message),
      );
    });
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });

interface Call {
  readonly route: ControlRouteName;
  readonly body?: unknown;
}

const parseArgs = (
  argv: ReadonlyArray<string>,
): { call: Call; json: boolean } | { error: string } => {
  const json = argv.includes("--json");
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const positional = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--profile" && argv[i - 1] !== "--path");
  const [cmd, a, b] = positional;

  switch (cmd) {
    case "doctor":
    case "profiles":
    case "pages":
    case "sessions":
      return { json, call: { route: cmd } };
    case "open":
      if (!a || !b) return { error: "open requires <nodeId> <url>" };
      return {
        json,
        call: {
          route: "open",
          body: { nodeId: a, url: b, ...(flag("profile") ? { profile: flag("profile") } : {}) },
        },
      };
    case "goto":
      if (!a || !b) return { error: "goto requires <nodeId> <url>" };
      return { json, call: { route: "goto", body: { nodeId: a, url: b } } };
    case "eval":
      if (!a || !b) return { error: "eval requires <nodeId> <code>" };
      return { json, call: { route: "eval", body: { nodeId: a, code: b } } };
    case "shot":
    case "screenshot":
      if (!a) return { error: "shot requires <nodeId>" };
      return {
        json,
        call: { route: "screenshot", body: { nodeId: a, ...(flag("path") ? { path: flag("path") } : {}) } },
      };
    case "close":
      if (!a) return { error: "close requires <nodeId>" };
      return { json, call: { route: "close", body: { nodeId: a } } };
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

const main = async (): Promise<void> => {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(parsed.error);
    process.exit(2);
  }

  const home = homedir();
  let token: string;
  try {
    token = (await readFile(controlTokenPath(home), "utf8")).trim();
  } catch {
    // No token file → the app has never started its control plane. Route
    // through the same human/json branching as every other error below, so
    // this runtime_down looks identical to the socket-level one regardless of
    // which path detected it.
    const envelope = controlErr("runtime_down", `token file missing: ${controlTokenPath(home)} — is the app running?`);
    if (parsed.json) {
      console.log(JSON.stringify(envelope));
    } else {
      console.error(`${envelope.error._tag}: ${envelope.error.message}`);
    }
    process.exit(1);
  }

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

await main();
