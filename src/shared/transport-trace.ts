/**
 * Failure tape for SSH, term sockets, and seat table transitions.
 * Install-local files under ~/.vellum-command/logs — not product state.
 */
import { join } from "node:path";
import { occupancyFromSummary } from "./terminal-seat-occupancy";
import { resolveVellumCommandHome } from "./vellum-home";

export const TRANSPORT_LOG_DIR_SEGMENTS = [".vellum-command", "logs"] as const;
export const TRANSPORT_LOG_FILE = "transport.jsonl";

export type TransportPlane = "ssh-transport" | "term" | "station";

export type TransportTraceEvent = {
  readonly ts: string;
  readonly plane: TransportPlane;
  readonly op: string;
  readonly ok: boolean;
  readonly hostId?: string;
  readonly bindingId?: string;
  readonly endpoint?: string;
  readonly socket?: string;
  readonly status?: string;
  readonly epoch?: string;
  /** Occupancy tag only after a real table snapshot. Never on a swallowed error. */
  readonly occupancy?: string;
  /** Table branch only: occupy | activate. Station project: install | idempotent | stale | conflict. */
  readonly decision?: string;
  /** Station projection generation. */
  readonly generation?: string;
  /** Station report record count. Never the records themselves. */
  readonly records?: number;
  readonly error?: string;
  readonly stack?: string;
  readonly stderr?: string;
  /** Failed request/response envelope. Write/PTY/token fields are omitted. */
  readonly frame?: string;
  readonly code?: number;
  readonly signal?: number;
  readonly ms?: number;
};

/** Occupancy from a completed get/create snapshot. Not for swallowed errors. */
export const seatTapeFromSummary = (
  bindingId: string,
  summary:
    | {
        readonly epoch?: string;
        readonly status?: string;
        readonly hostId?: string;
      }
    | null
    | undefined,
): {
  readonly status: string;
  readonly occupancy?: "VacantSeat" | "OccupiedSeat";
  readonly epoch?: string;
} => {
  const status =
    summary !== null &&
    summary !== undefined &&
    typeof summary.status === "string" &&
    summary.status.length > 0
      ? summary.status
      : "none";
  const liveStatus: "starting" | "running" | "exited" | "missing" | undefined =
    status === "starting" ||
    status === "running" ||
    status === "exited" ||
    status === "missing"
      ? status
      : undefined;
  const snapshot:
    | {
        readonly epoch: string;
        readonly status: "starting" | "running" | "exited" | "missing";
        readonly hostId?: string;
      }
    | undefined =
    summary !== null &&
    summary !== undefined &&
    typeof summary.epoch === "string" &&
    liveStatus !== undefined
      ? {
          epoch: summary.epoch,
          status: liveStatus,
          ...(summary.hostId === undefined ? {} : { hostId: summary.hostId }),
        }
      : undefined;
  const epoch =
    typeof summary?.epoch === "string" ? { epoch: summary.epoch } : {};
  if (bindingId.trim().length === 0) {
    return { status, ...epoch };
  }
  try {
    return {
      status,
      occupancy: occupancyFromSummary(bindingId, snapshot)._tag,
      ...epoch,
    };
  } catch {
    return { status, ...epoch };
  }
};

export const transportLogDirectory = (home = resolveVellumCommandHome()): string =>
  join(home, ...TRANSPORT_LOG_DIR_SEGMENTS);

export const transportLogPath = (home = resolveVellumCommandHome()): string =>
  join(transportLogDirectory(home), TRANSPORT_LOG_FILE);

/** Remote journal path from that machine's $HOME (not this process home). */
export const transportLogPathForHome = (osHome: string): string =>
  join(osHome, ...TRANSPORT_LOG_DIR_SEGMENTS, TRANSPORT_LOG_FILE);

export const filterTransportLog = (
  text: string,
  query?: string,
): string => {
  const q = query?.trim().toLowerCase();
  if (!q) return text;
  return text
    .split("\n")
    .filter((line) => line.toLowerCase().includes(q))
    .join("\n");
};

/** Redact credentials. Never shorten the rest — this tape is for debugging. */
export const redactTransportSecrets = (text: string): string =>
  text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, "<redacted-key>")
    .replace(/\bAuthorization:\s*Bearer\s+\S+/giu, "Authorization: Bearer <redacted>")
    .replace(/\b(?:token|bearer|password|secret)=[^\s]+/giu, "<redacted>");

export type TransportFailure = {
  readonly error: string;
  readonly stack?: string;
  readonly stderr?: string;
  readonly frame?: string;
};

/** Domain SSH errors stay classified. The journal looks this up for the raw body. */
const rememberedStderr = new WeakMap<object, string>();

export const rememberTransportStderr = (cause: object, stderr: string): void => {
  if (stderr.length === 0) return;
  rememberedStderr.set(cause, stderr.replaceAll("\u0000", ""));
};

const OMIT_FRAME_KEYS = new Set([
  "data",
  "journal",
  "token",
  "launch",
  "payload",
  "snapshot",
  "input",
  "stdout",
  "bytes",
]);

const sanitizeFrameValue = (value: unknown): unknown => {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") return redactTransportSecrets(value);
  if (Array.isArray(value)) return value.slice(0, 64).map(sanitizeFrameValue);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = OMIT_FRAME_KEYS.has(key) ? "<omitted>" : sanitizeFrameValue(child);
    }
    return out;
  }
  return String(value);
};

/** Failed protocol envelope for the journal. Drops PTY bytes and tokens. */
export const formatTransportFrame = (envelope: unknown): string =>
  JSON.stringify(sanitizeFrameValue(envelope));

const fieldFrom = (cause: object, key: string): string | undefined => {
  if (!(key in cause)) return undefined;
  const value = Reflect.get(cause, key);
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
};

export const formatTransportFailure = (cause: unknown): TransportFailure => {
  if (
    cause === null ||
    (!(cause instanceof Error) && typeof cause !== "object")
  ) {
    return { error: redactTransportSecrets(String(cause)) };
  }
  const object = cause as object & {
    readonly name?: string;
    readonly message?: string;
    readonly stack?: string;
    readonly cause?: unknown;
  };
  const name = typeof object.name === "string" ? object.name : "Error";
  const message =
    typeof object.message === "string" ? object.message : String(cause);
  const tag = fieldFrom(object, "_tag");
  const operation = fieldFrom(object, "operation");
  const code = fieldFrom(object, "code");
  const detail = fieldFrom(object, "detail");
  const stderr = fieldFrom(object, "stderr") ?? rememberedStderr.get(object);
  const frame = fieldFrom(object, "frame");
  const parts = [
    tag && tag !== name ? `${name} [${tag}]` : name,
    message,
    operation ? `operation=${operation}` : undefined,
    code ? `code=${code}` : undefined,
    detail && detail !== message ? detail : undefined,
  ].filter((part): part is string => Boolean(part));
  const nested =
    object.cause !== undefined && object.cause !== cause
      ? formatTransportFailure(object.cause)
      : undefined;
  if (nested) {
    parts.push(`cause: ${nested.error}`);
  }
  return {
    error: redactTransportSecrets(parts.join(" | ")),
    ...(typeof object.stack === "string" && object.stack.length > 0
      ? { stack: redactTransportSecrets(object.stack) }
      : nested?.stack
        ? { stack: nested.stack }
        : {}),
    ...(stderr
      ? { stderr: redactTransportSecrets(stderr) }
      : nested?.stderr
        ? { stderr: nested.stderr }
        : {}),
    ...(frame
      ? { frame: redactTransportSecrets(frame) }
      : nested?.frame
        ? { frame: nested.frame }
        : {}),
  };
};

export const sanitizeTransportError = (cause: unknown): string =>
  formatTransportFailure(cause).error;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;

const stringField = (
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined => {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const nestedRecord = (
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined => asRecord(record?.[key]);

/**
 * Station hop receipt. Generation, decision, readiness, report count.
 * Never the projection body or work records.
 */
export const stationTapeFromExchange = (
  request: unknown,
  response?: unknown,
): {
  readonly status?: string;
  readonly decision?: string;
  readonly generation?: string;
  readonly records?: number;
} => {
  const req = asRecord(request);
  const res = asRecord(response);
  const reqProjection = nestedRecord(req, "projection");
  const resProjection = nestedRecord(res, "projection") ?? nestedRecord(res, "active");
  const generation =
    stringField(reqProjection, "generation") ??
    stringField(resProjection, "generation");
  const decision = stringField(res, "decision");
  const state = stringField(res, "state");
  const readiness = nestedRecord(res, "readiness");
  const missing = readiness
    ? Object.entries(readiness)
        .filter(([, ready]) => ready === false)
        .map(([name]) => name)
    : [];
  const batch = nestedRecord(req, "batch") ?? nestedRecord(res, "batch");
  const records = Array.isArray(batch?.records) ? batch.records.length : undefined;
  const status =
    state === undefined
      ? undefined
      : missing.length > 0
        ? `${state} missing=${missing.join(",")}`
        : state;
  return {
    ...(status === undefined ? {} : { status }),
    ...(decision === undefined ? {} : { decision }),
    ...(generation === undefined ? {} : { generation }),
    ...(records === undefined ? {} : { records }),
  };
};
