import type {
  CheckDef,
  ClaimDef,
  TasksInboundContract,
  TasksOutboundContract,
  TasksSinkContract,
} from "@shared/work-model";

// Authoring-side shaping for the sink contract. The document stays sparse:
// blank prose, empty lists, and empty sub-bags are dropped rather than
// written as empty shells, so an untouched sink carries no contract at all.

const trimmed = (value: string | undefined): string | undefined => {
  const next = value?.trim();
  return next ? next : undefined;
};

const listOrUndefined = <T>(
  list: ReadonlyArray<T> | undefined,
): ReadonlyArray<T> | undefined => (list && list.length > 0 ? list : undefined);

const bagOrUndefined = <T extends object>(bag: T): T | undefined =>
  Object.keys(bag).length > 0 ? bag : undefined;

const normalizeChecklist = (
  checklist: ReadonlyArray<CheckDef> | undefined,
): ReadonlyArray<CheckDef> | undefined =>
  listOrUndefined(
    (checklist ?? []).flatMap((check) => {
      const label = trimmed(check.label);
      const command = trimmed(check.command);
      return label && command ? [{ id: check.id, label, command }] : [];
    }),
  );

const normalizeClaims = (
  claims: ReadonlyArray<ClaimDef> | undefined,
): ReadonlyArray<ClaimDef> | undefined =>
  listOrUndefined(
    (claims ?? []).flatMap((claim) => {
      const text = trimmed(claim.text);
      return text ? [{ id: claim.id, text, severity: claim.severity }] : [];
    }),
  );

const normalizeInbound = (
  inbound: TasksInboundContract | undefined,
): TasksInboundContract | undefined => {
  if (!inbound) return undefined;
  const instruction = trimmed(inbound.instruction);
  const description = trimmed(inbound.description);
  const checklist = normalizeChecklist(inbound.checklist);
  // "auto" is the product default — an explicit write of it is noise.
  const admission =
    inbound.admission && inbound.admission !== "auto" ? inbound.admission : undefined;
  const claimableAfterMs =
    typeof inbound.claimableAfterMs === "number" && inbound.claimableAfterMs > 0
      ? Math.round(inbound.claimableAfterMs)
      : undefined;
  return bagOrUndefined({
    ...(instruction ? { instruction } : {}),
    ...(description ? { description } : {}),
    ...(admission ? { admission } : {}),
    ...(claimableAfterMs !== undefined ? { claimableAfterMs } : {}),
    ...(checklist ? { checklist } : {}),
  });
};

const normalizeOutbound = (
  outbound: TasksOutboundContract | undefined,
): TasksOutboundContract | undefined => {
  if (!outbound) return undefined;
  const emission = trimmed(outbound.emission);
  const description = trimmed(outbound.description);
  const checklist = normalizeChecklist(outbound.checklist);
  return bagOrUndefined({
    ...(emission ? { emission } : {}),
    ...(description ? { description } : {}),
    ...(checklist ? { checklist } : {}),
  });
};

export const normalizeSinkContract = (
  contract: TasksSinkContract | undefined,
): TasksSinkContract | undefined => {
  if (!contract) return undefined;
  const instruction = trimmed(contract.instruction);
  const claims = normalizeClaims(contract.claims);
  const inbound = normalizeInbound(contract.inbound);
  const outbound = normalizeOutbound(contract.outbound);
  return bagOrUndefined({
    ...(instruction ? { instruction } : {}),
    ...(claims ? { claims } : {}),
    ...(inbound ? { inbound } : {}),
    ...(outbound ? { outbound } : {}),
  });
};

// Bake time as the operator speaks it. The wire carries milliseconds; this is
// the canvas-side twin of the seat's `holdFor` parser (src/cli/core/duration.ts)
// so both surfaces read one vocabulary.
const UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

export type BakeTimeParse =
  | { readonly ok: true; readonly ms: number | undefined }
  | { readonly ok: false };

/** Blank clears the bake. A bare number is milliseconds, as on the CLI. */
export const parseBakeTime = (raw: string): BakeTimeParse => {
  const value = raw.trim().toLowerCase();
  if (!value) return { ok: true, ms: undefined };
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)?$/.exec(value);
  if (match === null) return { ok: false };
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return { ok: false };
  const ms = Math.round(amount * UNIT_MS[match[2] ?? "ms"]!);
  return { ok: true, ms: ms > 0 ? ms : undefined };
};

const UNIT_ORDER: ReadonlyArray<readonly [string, number]> = [
  ["w", 604_800_000],
  ["d", 86_400_000],
  ["h", 3_600_000],
  ["m", 60_000],
  ["s", 1_000],
];

/** Largest whole unit that divides the value exactly, else milliseconds. */
export const formatBakeTime = (ms: number | undefined): string => {
  if (ms === undefined || ms <= 0) return "";
  for (const [unit, size] of UNIT_ORDER) {
    if (ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${ms}ms`;
};
