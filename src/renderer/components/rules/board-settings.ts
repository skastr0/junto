import type { Check, Rule, TasksContract, TasksIncoming, TasksOutgoing } from "@shared/work-model";

const trimmed = (value: string | undefined) => value?.trim() || undefined;
const list = <T,>(value: ReadonlyArray<T> | undefined) => value?.length ? value : undefined;
const checks = (value: ReadonlyArray<Check> | undefined) => list((value ?? []).flatMap((check) => {
  const label = trimmed(check.label); const command = trimmed(check.command);
  return label && command ? [{ id: check.id, label, command }] : [];
}));
const rules = (value: ReadonlyArray<Rule> | undefined) => list((value ?? []).flatMap((rule) => {
  const text = trimmed(rule.text); return text ? [{ id: rule.id, text }] : [];
}));
const incoming = (value: TasksIncoming | undefined): TasksIncoming | undefined => {
  if (!value) return undefined;
  const next = {
    ...(trimmed(value.handling) ? { handling: trimmed(value.handling) } : {}),
    ...(trimmed(value.description) ? { description: trimmed(value.description) } : {}),
    ...(value.admission && value.admission !== "auto" ? { admission: value.admission } : {}),
    ...(value.waitMs && value.waitMs > 0 ? { waitMs: Math.round(value.waitMs) } : {}),
    ...(checks(value.checks) ? { checks: checks(value.checks) } : {}),
  };
  return Object.keys(next).length ? next : undefined;
};
const outgoing = (value: TasksOutgoing | undefined): TasksOutgoing | undefined => {
  if (!value) return undefined;
  const next = {
    ...(trimmed(value.handoff) ? { handoff: trimmed(value.handoff) } : {}),
    ...(trimmed(value.description) ? { description: trimmed(value.description) } : {}),
    ...(checks(value.checks) ? { checks: checks(value.checks) } : {}),
  };
  return Object.keys(next).length ? next : undefined;
};
export const normalizeBoardSettings = (value: TasksContract | undefined): TasksContract | undefined => {
  if (!value) return undefined;
  const next = {
    ...(trimmed(value.instructions) ? { instructions: trimmed(value.instructions) } : {}),
    ...(rules(value.rules) ? { rules: rules(value.rules) } : {}),
    ...(incoming(value.incoming) ? { incoming: incoming(value.incoming) } : {}),
    ...(outgoing(value.outgoing) ? { outgoing: outgoing(value.outgoing) } : {}),
  };
  return Object.keys(next).length ? next : undefined;
};

const UNIT_MS: Readonly<Record<string, number>> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
export const parseWait = (raw: string): { readonly ok: true; readonly ms: number | undefined } | { readonly ok: false } => {
  const value = raw.trim().toLowerCase(); if (!value) return { ok: true, ms: undefined };
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)?$/.exec(value); if (!match) return { ok: false };
  const ms = Math.round(Number(match[1]) * UNIT_MS[match[2] ?? "ms"]!);
  return Number.isFinite(ms) ? { ok: true, ms: ms > 0 ? ms : undefined } : { ok: false };
};
export const formatWait = (ms: number | undefined): string => {
  if (!ms || ms <= 0) return "";
  for (const [unit, size] of [["w",604800000],["d",86400000],["h",3600000],["m",60000],["s",1000]] as const)
    if (ms % size === 0) return `${ms / size}${unit}`;
  return `${ms}ms`;
};
