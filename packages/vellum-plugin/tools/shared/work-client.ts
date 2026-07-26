import { accessSync, constants, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WorkCommandResult } from "../../schemas/tool-schemas.ts";

/** Wire protocol version (matches vellum work-control). */
export const WORK_PROTOCOL_VERSION = "vellum-work/v1";

export const WORK_DEFAULT_TIMEOUT_MS = 30_000;
export const WORK_MAX_FRAME_BYTES = 8 * 1024 * 1024;

export const WORK_HOME_ENV = "VELLUM_WORK_HOME";
export const WORK_SOCKET_ENV = "VELLUM_WORK_SOCKET";
export const ROUTE_TOKEN_ENV = "VELLUM_ROUTE_TOKEN";

/**
 * Opt-in plugin tool names. Advertised only when the station work socket is
 * reachable so nothing outside a live Vellum sees phantom tools.
 */
export const ADVERTISED_TOOL_NAMES = [
  "onboard",
  "tasks_list",
  "tasks_update",
  "msg_list",
  "msg_send",
  "request_create",
  "artifact_publish",
] as const;

export type AdvertisedToolName = (typeof ADVERTISED_TOOL_NAMES)[number];

export type WorkOpName =
  | "ping"
  | "doctor"
  | "capabilities"
  | "onboard"
  | "tasks.list"
  | "tasks.claim"
  | "tasks.update"
  | "msg.list"
  | "msg.send"
  | "request.create"
  | "request.escalate"
  | "artifact.publish";

export interface WorkClientPaths {
  readonly workHome: string;
  readonly socketPath: string;
  readonly tokenPath: string;
}

const defaultWorkHome = (): string => join(homedir(), ".vellum", "work");

/** Resolve work home: `VELLUM_WORK_HOME` or `~/.vellum/work`. */
export const resolveWorkHome = (
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const override = env[WORK_HOME_ENV]?.trim();
  if (override) return override;
  return defaultWorkHome();
};

/** Socket + token paths. `VELLUM_WORK_SOCKET` overrides the socket path only. */
export const resolveWorkPaths = (
  env: NodeJS.ProcessEnv = process.env,
): WorkClientPaths => {
  const workHome = resolveWorkHome(env);
  const socketOverride = env[WORK_SOCKET_ENV]?.trim();
  return {
    workHome,
    socketPath: socketOverride || join(workHome, "control.sock"),
    tokenPath: join(workHome, "token"),
  };
};

export const encodeWorkFrame = (value: unknown): string =>
  `${JSON.stringify(value)}\n`;

/**
 * True when the work control socket path looks reachable (exists on disk).
 * Fail-closed: missing path / inaccessible → not reachable.
 * Does not open a connection (cheap gate for advertise).
 */
export const isWorkSocketReachable = (
  env: NodeJS.ProcessEnv = process.env,
): boolean => {
  const { socketPath } = resolveWorkPaths(env);
  if (!socketPath || !existsSync(socketPath)) return false;
  try {
    accessSync(socketPath, constants.R_OK | constants.W_OK);
    return true;
  } catch {
    // Socket file may still be connectable without R/W bits on some platforms.
    return existsSync(socketPath);
  }
};

/**
 * Tool names this opt-in plugin should advertise.
 * Empty when no station socket is reachable — no phantom tools outside Vellum.
 */
export const listAdvertisedTools = (
  env: NodeJS.ProcessEnv = process.env,
): readonly AdvertisedToolName[] => {
  if (!isWorkSocketReachable(env)) return [];
  return ADVERTISED_TOOL_NAMES;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseResponseEnvelope = (
  raw: unknown,
):
  | { readonly ok: true; readonly data: unknown; readonly op?: string }
  | {
      readonly ok: false;
      readonly error: {
        readonly type: string;
        readonly message: string;
        readonly details?: unknown;
      };
      readonly op?: string;
    }
  | undefined => {
  if (!isRecord(raw) || typeof raw.ok !== "boolean") return undefined;
  if (raw.ok === true) {
    return {
      ok: true,
      data: "data" in raw ? raw.data : undefined,
      ...(typeof raw.op === "string" ? { op: raw.op } : {}),
    };
  }
  if (!isRecord(raw.error) || typeof raw.error.message !== "string") {
    return undefined;
  }
  return {
    ok: false,
    error: {
      type: typeof raw.error.type === "string" ? raw.error.type : "ProtocolError",
      message: raw.error.message,
      ...("details" in raw.error ? { details: raw.error.details } : {}),
    },
    ...(typeof raw.op === "string" ? { op: raw.op } : {}),
  };
};

const readToken = async (
  tokenPath: string,
  env: NodeJS.ProcessEnv,
): Promise<string> => {
  const route = env[ROUTE_TOKEN_ENV]?.trim();
  if (route) return route;
  try {
    const text = (await readFile(tokenPath, "utf8")).trim();
    if (!text) {
      throw new Error("work control token empty — is Vellum running?");
    }
    return text;
  } catch (error) {
    if (error instanceof Error && error.message.includes("token empty")) {
      throw error;
    }
    throw new Error("work control token unavailable — is Vellum running?");
  }
};

const ndjsonCall = (
  socketPath: string,
  token: string,
  op: WorkOpName,
  args: unknown,
  timeoutMs: number,
): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let settled = false;
    let buffer = Buffer.alloc(0);
    let socket: Socket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      try {
        socket?.destroy();
      } catch {
        // ignore
      }
      fn();
    };

    timer = setTimeout(() => {
      settle(() =>
        reject(new Error(`request timed out after ${timeoutMs}ms`)),
      );
    }, timeoutMs);

    try {
      socket = createConnection({ path: socketPath });
    } catch (error) {
      settle(() =>
        reject(
          new Error(
            error instanceof Error
              ? error.message
              : "failed to open work control socket",
          ),
        ),
      );
      return;
    }

    socket.on("connect", () => {
      // Identity is process-bind (peer PID). No client-supplied nodeRef.
      const frame = encodeWorkFrame({
        token,
        op,
        ...(args !== undefined ? { args } : {}),
      });
      socket?.write(frame);
    });

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > WORK_MAX_FRAME_BYTES) {
        settle(() =>
          reject(
            new Error(`response exceeds ${WORK_MAX_FRAME_BYTES} bytes`),
          ),
        );
        return;
      }
      const nl = buffer.indexOf(0x0a);
      if (nl < 0) return;
      const line = buffer
        .subarray(0, nl)
        .toString("utf8")
        .replace(/\r$/, "")
        .trim();
      try {
        const raw = JSON.parse(line) as unknown;
        settle(() => resolve(raw));
      } catch {
        settle(() => reject(new Error("server returned non-JSON")));
      }
    });

    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (
        error.code === "ENOENT" ||
        error.code === "ECONNREFUSED" ||
        error.code === "FailedToOpenSocket"
      ) {
        settle(() =>
          reject(
            new Error("vellum app is not running (work socket down)"),
          ),
        );
        return;
      }
      settle(() => reject(new Error(error.message)));
    });

    socket.on("close", () => {
      if (!settled) {
        settle(() =>
          reject(new Error("socket closed before response")),
        );
      }
    });
  });

export interface CallWorkOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

/**
 * Call a work-control op over the local Unix socket (Tier 2) or with a
 * route-token when `VELLUM_ROUTE_TOKEN` is set (Tier 3 token supply).
 * Transport is owned by the plugin — no separate CLI binary required.
 */
export const callWork = async (
  op: WorkOpName,
  args?: unknown,
  options: CallWorkOptions = {},
): Promise<WorkCommandResult> => {
  const env = options.env ?? process.env;
  const paths = resolveWorkPaths(env);
  const timeoutMs = options.timeoutMs ?? WORK_DEFAULT_TIMEOUT_MS;

  try {
    const token = await readToken(paths.tokenPath, env);
    const raw = await ndjsonCall(
      paths.socketPath,
      token,
      op,
      args,
      timeoutMs,
    );
    const envelope = parseResponseEnvelope(raw);
    if (!envelope) {
      return {
        ok: false,
        op,
        error: {
          type: "ProtocolError",
          message: "server returned a malformed envelope",
        },
      };
    }
    if (envelope.ok) {
      return {
        ok: true,
        op: envelope.op ?? op,
        data: envelope.data,
      };
    }
    return {
      ok: false,
      op: envelope.op ?? op,
      error: envelope.error,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    const type =
      message.includes("not running") ||
      message.includes("token unavailable") ||
      message.includes("token empty")
        ? "RuntimeDown"
        : message.includes("timed out")
          ? "ProtocolError"
          : "InternalError";
    return {
      ok: false,
      op,
      error: {
        type,
        message,
        details:
          type === "RuntimeDown"
            ? { next_step: "launch Vellum, then re-run onboard", retryable: true }
            : type === "ProtocolError"
              ? { retryable: true }
              : undefined,
      },
    };
  }
};

/** Format onboard data for a brief human/tool summary. */
export const formatOnboardSummary = (data: unknown): string => {
  if (!isRecord(data)) {
    return `Vellum onboard ok (protocol ${WORK_PROTOCOL_VERSION}).`;
  }
  const nodeRef =
    typeof data.nodeRef === "string" ? data.nodeRef : undefined;
  const role = typeof data.role === "string" ? data.role : undefined;
  const connected = Array.isArray(data.connected)
    ? data.connected.length
    : undefined;
  const parts = [
    "Vellum factory onboard",
    nodeRef ? `seat ${nodeRef}` : undefined,
    role ? `role ${role}` : undefined,
    connected !== undefined ? `${connected} connected targets` : undefined,
  ].filter(Boolean);
  return `${parts.join(" · ")}.`;
};
