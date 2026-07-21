/**
 * Agent-side browser control-plane client for e2e — a minimal node:http
 * client over the unix-domain socket, built from the same wire contract
 * module (`@shared/browser-control`) real agents (scripts/browser-cli.ts,
 * the local vellum-browser CLI) use. Deliberately independent of the
 * product's own CLI process so a test can hand-craft headers (missing
 * capability, malformed request id, ...) to exercise the denial paths.
 *
 * Never touches the operator's real ~/.vellum: every caller passes the
 * sandbox's homeDir (HOME is already sandboxed by e2e/harness/launch.ts, so
 * the app's own control plane lives under that same temp home).
 */
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { Either } from "effect";
import {
  CONTROL_CAPABILITY_HEADER,
  CONTROL_REQUEST_ID_HEADER,
  CONTROL_ROUTES,
  CONTROL_TOKEN_HEADER,
  controlSocketPath,
  controlTokenPath,
  decodeControlEnvelope,
  type ControlEnvelope,
  type ControlRouteName,
} from "../../src/shared/browser-control";

export interface ControlCallOptions {
  readonly capability?: string;
  /** Override the auto-generated request id — used to probe malformed ids. */
  readonly requestId?: string;
  readonly timeoutMs?: number;
}

export interface ControlCallResult {
  readonly status: number;
  readonly envelope: ControlEnvelope<unknown>;
}

export const readSandboxControlToken = async (home: string): Promise<string> =>
  (await readFile(controlTokenPath(home), "utf8")).trim();

export const sandboxControlSocketPath = (home: string): string => controlSocketPath(home);

/**
 * Full control-plane round trip with hand-craftable headers. Distinct from
 * scripts/browser-cli.ts's own httpOverSocket (which always sends a
 * well-formed request) — this one lets a test omit/mangle the capability or
 * request-id header to exercise the server's denial paths directly.
 */
export const controlCall = (
  socketPath: string,
  token: string | undefined,
  routeName: ControlRouteName,
  body?: unknown,
  options: ControlCallOptions = {},
): Promise<ControlCallResult> =>
  new Promise((resolve, reject) => {
    const route = CONTROL_ROUTES[routeName];
    const timeoutMs = options.timeoutMs ?? 5_000;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (result: { readonly value: ControlCallResult } | { readonly error: unknown }): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if ("value" in result) resolve(result.value);
      else reject(result.error);
    };

    const encodedBody = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        socketPath,
        method: route.method,
        path: route.path,
        headers: {
          "content-type": "application/json",
          ...(token === undefined ? {} : { [CONTROL_TOKEN_HEADER]: token }),
          ...(options.capability === undefined
            ? {}
            : { [CONTROL_CAPABILITY_HEADER]: options.capability }),
          ...(options.requestId === undefined && options.capability === undefined
            ? {}
            : { [CONTROL_REQUEST_ID_HEADER]: options.requestId ?? randomUUID() }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const status = res.statusCode ?? 0;
            const raw = Buffer.concat(chunks).toString("utf8");
            const decoded = decodeControlEnvelope(raw.length === 0 ? undefined : JSON.parse(raw));
            if (Either.isLeft(decoded)) {
              settle({ error: new Error(`malformed control envelope: ${decoded.left.message}`) });
              return;
            }
            settle({ value: { status, envelope: decoded.right } });
          } catch (error) {
            settle({ error });
          }
        });
      },
    );
    timer = setTimeout(() => {
      req.destroy();
      settle({ error: new Error(`control call timed out after ${timeoutMs}ms`) });
    }, timeoutMs);
    req.on("error", (error) => settle({ error }));
    if (encodedBody !== undefined) req.write(encodedBody);
    req.end();
  });

export const waitForControlDoctor = async (
  socketPath: string,
  token: string,
  timeoutMs = 30_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError = "control plane not ready";
  while (Date.now() < deadline) {
    try {
      const result = await controlCall(socketPath, token, "doctor");
      if (result.status === 200 && result.envelope.ok) return;
      lastError = `doctor returned status ${result.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`control plane doctor timed out: ${lastError}`);
};
