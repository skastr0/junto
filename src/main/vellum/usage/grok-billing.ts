// Pure decoders for the Grok (xAI) billing wire surfaces. Modeled on the
// reverse-engineered protocol: the CLI credits proxy JSON endpoint and the
// grok.com gRPC-web GetGrokCreditsConfig protobuf (hand-parsed - no schema).
// Everything here is total: malformed payloads yield undefined / error
// outcomes, never throws. Monetary amounts on the proxy surface are cents
// encoded as { val: n }; subscription credits are never converted to dollars.

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Replace every occurrence of secret material before a string reaches an envelope. */
export const redactSecret = (text: string, secret: string | undefined): string =>
  secret !== undefined && secret !== "" ? text.split(secret).join("[redacted]") : text;

/**
 * Grok consumer plan display names. The billed tier lives in CLI settings
 * `subscription_tier_display`; normalize known compact variants.
 */
export const normalizeGrokPlanName = (raw: string | undefined): string | undefined => {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return undefined;
  const compact = trimmed.toLowerCase().replace(/[^a-z]/g, "");
  if (compact === "supergrokheavy" || compact === "heavy") return "SuperGrok Heavy";
  if (compact === "supergrok") return "SuperGrok";
  return trimmed;
};

export interface GrokProxyBillingSnapshot {
  /** 0-100 clamped usage percent, when the payload publishes or derives one. */
  readonly usedPercent?: number;
  readonly resetsAt?: string;
  readonly subscriptionTier?: string;
}

const parseIso = (value: unknown): string | undefined => {
  const raw = asString(value);
  if (raw === undefined) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
};

/**
 * Decode of GET https://cli-chat-proxy.grok.com/v1/billing?format=credits:
 * { config: { creditUsagePercent, currentPeriod.end, billingPeriodEnd,
 * onDemandCap.val, onDemandUsed.val, subscriptionTier }, subscriptionTier }.
 * Returns undefined when no usable config object exists.
 */
export const parseGrokProxyBilling = (payload: unknown): GrokProxyBillingSnapshot | undefined => {
  if (!isObject(payload)) return undefined;
  const config = isObject(payload.config) ? payload.config : undefined;
  if (config === undefined) return undefined;

  let usedPercent: number | undefined;
  const direct = asNumber(config.creditUsagePercent);
  if (direct !== undefined && Number.isFinite(direct)) {
    usedPercent = Math.min(100, Math.max(0, direct));
  } else {
    const cap = asNumber(isObject(config.onDemandCap) ? config.onDemandCap.val : undefined);
    const used = asNumber(isObject(config.onDemandUsed) ? config.onDemandUsed.val : undefined);
    if (cap !== undefined && cap > 0 && used !== undefined) {
      usedPercent = Math.min(100, Math.max(0, (used / cap) * 100));
    }
  }

  const resetsAt = parseIso(
    isObject(config.currentPeriod) ? config.currentPeriod.end : undefined,
  ) ?? parseIso(config.billingPeriodEnd);

  const tierRaw =
    asString(config.subscriptionTier) ?? asString(payload.subscriptionTier) ?? undefined;
  const subscriptionTier = normalizeGrokPlanName(tierRaw);

  if (usedPercent === undefined && resetsAt === undefined && subscriptionTier === undefined) {
    return undefined;
  }
  return {
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(subscriptionTier !== undefined ? { subscriptionTier } : {}),
  };
};

/** Decode of GET https://cli-chat-proxy.grok.com/v1/settings -> plan display name. */
export const parseGrokSettingsTier = (payload: unknown): string | undefined => {
  if (!isObject(payload)) return undefined;
  return normalizeGrokPlanName(asString(payload.subscription_tier_display));
};

/**
 * CodexBar window-label heuristic for Grok's untyped credits surface:
 * 4-12 days of duration reads Weekly, 20-45 days reads Monthly. An untyped
 * window that only carries resetsAt keeps the Weekly label near reset; the
 * web path never infers cadence from time-until-reset alone beyond that.
 */
export const grokPrimaryTitle = (
  windowMinutes: number | undefined,
  resetsAtMs: number | undefined,
  nowMs: number,
): string | undefined => {
  const fromMinutes = titleForDurationDays(windowMinutes === undefined ? undefined : windowMinutes / (24 * 60));
  if (fromMinutes !== undefined) return fromMinutes;
  if (windowMinutes !== undefined) return undefined;
  // No typed duration: fall back to reset distance, then the weekly-pool default.
  const fromReset = titleForDurationDays(resetsAtMs === undefined ? undefined : (resetsAtMs - nowMs) / (24 * 60 * 1000));
  return fromReset ?? (resetsAtMs !== undefined ? "Weekly" : undefined);
};

const titleForDurationDays = (days: number | undefined): string | undefined => {
  if (days === undefined || !Number.isFinite(days)) return undefined;
  const rounded = Math.round(days);
  if (rounded >= 4 && rounded <= 12) return "Weekly";
  if (rounded >= 20 && rounded <= 45) return "Monthly";
  return undefined;
};

// ---------------------------------------------------------------------------
// gRPC-web GetGrokCreditsConfig hand-parsed protobuf
// ---------------------------------------------------------------------------

export interface GrokGrpcWebSnapshot {
  readonly usedPercent: number;
  /** False when the percent was fabricated for a no-usage-yet period frame. */
  readonly wirePublished: boolean;
  readonly resetsAt?: string;
}

export type GrokGrpcWebOutcome =
  | { readonly kind: "ok"; readonly snapshot: GrokGrpcWebSnapshot }
  | { readonly kind: "error"; readonly message: string };

interface Fixed32Field {
  readonly path: number[];
  readonly value: number;
  readonly order: number;
}

interface VarintField {
  readonly path: number[];
  readonly value: bigint;
}

interface ProtobufScan {
  readonly fixed32: Fixed32Field[];
  readonly varints: VarintField[];
}

/** grpc-web data frames: 1 flag byte + 4 big-endian length bytes per frame. */
export const grpcWebDataFrames = (data: Uint8Array): Uint8Array[] => {
  const frames: Uint8Array[] = [];
  let index = 0;
  while (index < data.length) {
    if (index + 5 > data.length) return [];
    const flags = data[index]!;
    const length =
      (data[index + 1]! << 24) | (data[index + 2]! << 16) | (data[index + 3]! << 8) | data[index + 4]!;
    const start = index + 5;
    const end = start + length;
    if (length < 0 || end > data.length) return [];
    if ((flags & 0x80) === 0) frames.push(data.subarray(start, end));
    index = end;
  }
  return frames;
};

/** Trailer frames (flag bit 0x80) carry "grpc-status: N" style lines. */
export const grpcWebTrailerFields = (data: Uint8Array): Record<string, string> => {
  const fields: Record<string, string> = {};
  let index = 0;
  while (index + 5 <= data.length) {
    const flags = data[index]!;
    const length =
      (data[index + 1]! << 24) | (data[index + 2]! << 16) | (data[index + 3]! << 8) | data[index + 4]!;
    const start = index + 5;
    const end = start + length;
    if (length < 0 || end > data.length) break;
    if ((flags & 0x80) !== 0) {
      const text = new TextDecoder().decode(data.subarray(start, end));
      for (const line of text.split("\n")) {
        if (line === "") continue;
        const separator = line.indexOf(":");
        if (separator < 0) continue;
        const key = line.slice(0, separator).trim().toLowerCase();
        let value = line.slice(separator + 1).trim();
        try {
          value = decodeURIComponent(value);
        } catch {
          // keep raw trailer value
        }
        fields[key] = value;
      }
    }
    index = end;
  }
  return fields;
};

const readVarint = (bytes: Uint8Array, index: { i: number }): bigint | undefined => {
  let value = 0n;
  let shift = 0n;
  while (index.i < bytes.length && shift < 64n) {
    const byte = bytes[index.i]!;
    index.i += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value;
    shift += 7n;
  }
  return undefined;
};

const scanProtobuf = (data: Uint8Array, depth: number, path: number[], state: { order: number }): ProtobufScan => {
  const fixed32: Fixed32Field[] = [];
  const varints: VarintField[] = [];
  let index = 0;
  while (index < data.length) {
    const fieldStart = index;
    const keyIndex = { i: index };
    const key = readVarint(data, keyIndex);
    if (key === undefined || key === 0n) {
      index = fieldStart + 1;
      continue;
    }
    index = keyIndex.i;
    const fieldNumber = Number(key >> 3n);
    const wireType = Number(key & 7n);
    const fieldPath = [...path, fieldNumber];
    if (wireType === 0) {
      const valueIndex = { i: index };
      const value = readVarint(data, valueIndex);
      if (value !== undefined) {
        varints.push({ path: fieldPath, value });
        index = valueIndex.i;
      } else {
        index = fieldStart + 1;
      }
    } else if (wireType === 1) {
      index += 8;
    } else if (wireType === 2) {
      const lengthIndex = { i: index };
      const length = readVarint(data, lengthIndex);
      if (length === undefined || length > BigInt(data.length - lengthIndex.i)) {
        index = fieldStart + 1;
        continue;
      }
      const start = lengthIndex.i;
      const end = start + Number(length);
      if (depth < 4) {
        const nested = scanProtobuf(data.subarray(start, end), depth + 1, fieldPath, state);
        fixed32.push(...nested.fixed32);
        varints.push(...nested.varints);
      }
      index = end;
    } else if (wireType === 5) {
      if (index + 4 > data.length) break;
      const view = new DataView(data.buffer, data.byteOffset + index, 4);
      fixed32.push({ path: fieldPath, value: view.getFloat32(0, true), order: state.order });
      state.order += 1;
      index += 4;
    } else {
      index = fieldStart + 1;
    }
  }
  return { fixed32, varints };
};

const looksLikeProtobuf = (data: Uint8Array): boolean => {
  if (data.length === 0) return false;
  const first = data[0]!;
  const fieldNumber = first >> 3;
  const wireType = first & 0x07;
  return fieldNumber > 0 && (wireType === 0 || wireType === 1 || wireType === 2 || wireType === 5);
};

/**
 * Parse a GetGrokCreditsConfig gRPC-web response body.
 * Usage percent is the shallowest fixed32 float in [0,100] whose path ends in
 * field 1; reset is a plausible epoch-seconds varint preferring path [1,5,1].
 * A period frame with no percentage field at all is the surface's own
 * no-usage-yet contract and reports a fabricated-but-flagged 0.
 */
export const parseGrokGrpcWebBilling = (
  data: Uint8Array,
  nowMs: number = Date.now(),
): GrokGrpcWebOutcome => {
  const trailers = grpcWebTrailerFields(data);
  const rawStatus = trailers["grpc-status"];
  if (rawStatus !== undefined) {
    const status = Number.parseInt(rawStatus, 10);
    if (Number.isFinite(status) && status !== 0) {
      return { kind: "error", message: trailers["grpc-message"] ?? "" };
    }
  }

  let payloads = grpcWebDataFrames(data);
  if (payloads.length === 0 && looksLikeProtobuf(data)) payloads = [data];
  if (payloads.length === 0) return { kind: "error", message: "no protobuf payload in response" };

  const state = { order: 0 };
  const scan: ProtobufScan = { fixed32: [], varints: [] };
  for (const payload of payloads) {
    const partial = scanProtobuf(payload, 0, [], state);
    scan.fixed32.push(...partial.fixed32);
    scan.varints.push(...partial.varints);
  }

  const percentCandidates = scan.fixed32.filter(
    (field) =>
      field.path[field.path.length - 1] === 1 &&
      Number.isFinite(field.value) &&
      field.value >= 0 &&
      field.value <= 100,
  );
  const parsedPercent = percentCandidates.length
    ? percentCandidates.reduce((best, field) =>
        field.path.length !== best.path.length
          ? field.path.length < best.path.length
            ? field
            : best
          : field.order < best.order
            ? field
            : best,
      ).value
    : undefined;

  const epochSeconds = scan.varints
    .map((field) => ({ path: field.path, seconds: Number(field.value) }))
    .filter((field) => field.seconds >= 1_700_000_000 && field.seconds <= 2_100_000_000)
    .filter((field) => field.seconds * 1000 > nowMs);
  const preferredReset = epochSeconds.find(
    (field) => field.path.length === 3 && field.path[0] === 1 && field.path[1] === 5 && field.path[2] === 1,
  );
  const chosenReset = preferredReset ?? epochSeconds.reduce<(typeof epochSeconds)[number] | undefined>(
    (best, field) => (best === undefined || field.seconds < best.seconds ? field : best),
    undefined,
  );

  const hasUsagePeriod = scan.varints.some(
    (field) =>
      (field.path.length >= 2 && field.path[0] === 1 && field.path[1] === 6) ||
      (field.path.length === 3 &&
        field.path[0] === 1 &&
        field.path[1] === 8 &&
        field.path[2] === 1 &&
        (field.value === 1n || field.value === 2n)),
  );
  const noUsageYet = parsedPercent === undefined && scan.fixed32.length === 0 && chosenReset !== undefined && hasUsagePeriod;
  if (parsedPercent === undefined && !noUsageYet) {
    return { kind: "error", message: "no usable usage percent in credits frame" };
  }

  const percent = parsedPercent ?? 0;
  const resetsAt = chosenReset !== undefined ? new Date(chosenReset.seconds * 1000).toISOString() : undefined;
  return {
    kind: "ok",
    snapshot: {
      usedPercent: Math.min(100, Math.max(0, percent)),
      wirePublished: parsedPercent !== undefined,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    },
  };
};
