/**
 * Durable transport / occupancy receipts.
 * Install-local files under ~/.vellum-command/logs — not product state.
 */
import { join } from "node:path";
import { resolveVellumCommandHome } from "./vellum-home";

export const TRANSPORT_LOG_DIR_SEGMENTS = [".vellum-command", "logs"] as const;
export const TRANSPORT_LOG_FILE = "transport.jsonl";

export type TransportPlane = "ssh-transport" | "term" | "station" | "work" | "browser";

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
  readonly occupancy?: string;
  readonly decision?: string;
  readonly error?: string;
  readonly ms?: number;
};

export const transportLogDirectory = (home = resolveVellumCommandHome()): string =>
  join(home, ...TRANSPORT_LOG_DIR_SEGMENTS);

export const transportLogPath = (home = resolveVellumCommandHome()): string =>
  join(transportLogDirectory(home), TRANSPORT_LOG_FILE);

export const sanitizeTransportError = (cause: unknown): string => {
  const raw = cause instanceof Error ? cause.message : String(cause);
  return raw
    .replace(/\b(?:token|bearer|password|secret)=[^\s]+/giu, "<redacted>")
    .slice(0, 400);
};
