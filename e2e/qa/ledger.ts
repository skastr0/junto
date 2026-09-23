/**
 * QA ledger, shared by every tier: deterministic fingerprints, the 2-of-3 flake gate, and a
 * merge that keeps one entry per fingerprint across runs.
 *
 * A fingerprint names the defect, not the run: surface, action, invariant, and
 * a normalized signature with ids, numbers, paths, and URLs stripped. Context
 * (theme, scale, viewport) is recorded on the finding but kept out of the
 * fingerprint, so the same defect seen under two contexts is one finding.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Violation } from "./oracle";

export const LEDGER_SCHEMA = "junto.qa-ledger/v1";

/** t0: scripted e2e probes; t1: scripted Cua Driver on the packaged app; explore: Jev-chosen Cua probes. */
export type Tier = "t0" | "t1" | "explore";

export interface ProbeContext {
  readonly theme: string;
  readonly scale: number;
  readonly viewport: string;
}

/** One probe execution, as the spec writes it. */
export interface AttemptRecord {
  /** Absent on T0 records, which predate the other tiers. */
  readonly tier?: Tier;
  readonly attempt: number;
  readonly probeId: string;
  readonly surface: string;
  readonly action: string;
  readonly context: ProbeContext;
  readonly durationMs: number;
  readonly violations: ReadonlyArray<Violation>;
  readonly evidence?: string;
}

export type FindingStatus = "confirmed" | "flaky";

export interface Finding {
  readonly fingerprint: string;
  readonly tier: Tier;
  readonly status: FindingStatus;
  readonly surface: string;
  readonly action: string;
  readonly invariant: string;
  readonly signature: string;
  readonly detail: string;
  readonly contexts: ReadonlyArray<string>;
  readonly probes: ReadonlyArray<string>;
  /** Per attempt of the probe that best reproduced it: true = seen. */
  readonly attempts: ReadonlyArray<boolean>;
  readonly evidence?: string;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly runsSeen: number;
}

export interface RunSummary {
  readonly tier: Tier;
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly commit: string;
  readonly plan: { readonly probes: number; readonly fullCrossProduct: number; readonly pairsCovered: number };
  readonly probeExecutions: number;
  readonly probesClean: number;
  readonly findings: { readonly total: number; readonly confirmed: number; readonly flaky: number; readonly new: number };
  readonly harnessFailures: ReadonlyArray<string>;
}

export interface Ledger {
  readonly schema: typeof LEDGER_SCHEMA;
  readonly updatedAt: string;
  readonly runs: ReadonlyArray<RunSummary>;
  readonly findings: ReadonlyArray<Finding>;
}

export const normalizeSignature = (signature: string): string =>
  signature
    .toLowerCase()
    .replace(/[a-z]+:\/\/[^\s"')]+/g, "<url>")
    .replace(/(?:\/[\w.@-]+){2,}/g, "<path>")
    .replace(/\b[0-9a-f]{8,}\b/g, "<hex>")
    .replace(/\d+(?:\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();

export const fingerprintOf = (surface: string, action: string, violation: Violation): string =>
  createHash("sha256")
    .update([surface, action, violation.invariant, normalizeSignature(violation.signature)].join("|"))
    .digest("hex")
    .slice(0, 16);

const contextKey = (context: ProbeContext): string => `${context.theme}/${context.scale}x/${context.viewport}`;

/** Reruns only need the probes whose first attempt saw something. */
export const probesToRerun = (records: ReadonlyArray<AttemptRecord>): string[] =>
  [...new Set(records.filter((record) => record.violations.length > 0).map((record) => record.probeId))].sort();

/**
 * Fold every attempt into one finding per fingerprint. A finding is confirmed
 * when some probe reproduced it in at least 2 of its 3 attempts; otherwise it
 * is flaky. Both are kept: a flake is still evidence.
 */
export const foldFindings = (records: ReadonlyArray<AttemptRecord>, now: string): Finding[] => {
  interface Acc {
    tier: Tier;
    surface: string;
    action: string;
    violation: Violation;
    contexts: Set<string>;
    seen: Map<string, Set<number>>; // probeId -> attempts that saw it
    evidence?: string;
  }
  const byFingerprint = new Map<string, Acc>();
  for (const record of records) {
    for (const violation of record.violations) {
      const fingerprint = fingerprintOf(record.surface, record.action, violation);
      let acc = byFingerprint.get(fingerprint);
      if (!acc) {
        acc = {
          tier: record.tier ?? "t0",
          surface: record.surface,
          action: record.action,
          violation,
          contexts: new Set(),
          seen: new Map(),
        };
        byFingerprint.set(fingerprint, acc);
      }
      acc.contexts.add(contextKey(record.context));
      const attempts = acc.seen.get(record.probeId) ?? new Set<number>();
      attempts.add(record.attempt);
      acc.seen.set(record.probeId, attempts);
      acc.evidence ??= record.evidence;
    }
  }
  const findings: Finding[] = [];
  for (const [fingerprint, acc] of byFingerprint) {
    const attemptsRun = (probeId: string): number[] =>
      [...new Set(records.filter((r) => r.probeId === probeId).map((r) => r.attempt))].sort();
    let best: boolean[] = [];
    for (const [probeId, seenIn] of acc.seen) {
      const flags = attemptsRun(probeId).map((attempt) => seenIn.has(attempt));
      if (flags.filter(Boolean).length > best.filter(Boolean).length) best = flags;
    }
    findings.push({
      fingerprint,
      tier: acc.tier,
      status: best.filter(Boolean).length >= 2 ? "confirmed" : "flaky",
      surface: acc.surface,
      action: acc.action,
      invariant: acc.violation.invariant,
      signature: normalizeSignature(acc.violation.signature),
      detail: acc.violation.detail,
      contexts: [...acc.contexts].sort(),
      probes: [...acc.seen.keys()].sort(),
      attempts: best,
      ...(acc.evidence ? { evidence: acc.evidence } : {}),
      firstSeen: now,
      lastSeen: now,
      runsSeen: 1,
    });
  }
  return findings.sort((a, b) =>
    a.status === b.status ? a.fingerprint.localeCompare(b.fingerprint) : a.status === "confirmed" ? -1 : 1,
  );
};

/** Merge this run into the prior ledger: same fingerprint, one entry. */
export const mergeLedger = (
  prior: Ledger | undefined,
  run: RunSummary,
  current: ReadonlyArray<Finding>,
  now: string,
): { ledger: Ledger; newCount: number } => {
  const merged = new Map<string, Finding>();
  for (const finding of prior?.findings ?? []) merged.set(finding.fingerprint, finding);
  let newCount = 0;
  for (const finding of current) {
    const old = merged.get(finding.fingerprint);
    if (!old) newCount += 1;
    merged.set(
      finding.fingerprint,
      old
        ? {
            ...finding,
            firstSeen: old.firstSeen,
            runsSeen: old.runsSeen + 1,
            contexts: [...new Set([...old.contexts, ...finding.contexts])].sort(),
            probes: [...new Set([...old.probes, ...finding.probes])].sort(),
          }
        : finding,
    );
  }
  const findings = [...merged.values()].sort((a, b) =>
    a.status === b.status ? b.lastSeen.localeCompare(a.lastSeen) || a.fingerprint.localeCompare(b.fingerprint) : a.status === "confirmed" ? -1 : 1,
  );
  const runs = [...(prior?.runs ?? []), { ...run, findings: { ...run.findings, new: newCount } }].slice(-20);
  return { ledger: { schema: LEDGER_SCHEMA, updatedAt: now, runs, findings }, newCount };
};

/** Merge one run into the ledger file on disk; returns how many fingerprints were new. */
export const writeRun = (
  ledgerPath: string,
  run: RunSummary,
  findings: ReadonlyArray<Finding>,
  now: string,
): number => {
  const prior = existsSync(ledgerPath) ? (JSON.parse(readFileSync(ledgerPath, "utf8")) as Ledger) : undefined;
  const { ledger, newCount } = mergeLedger(prior, run, findings, now);
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  return newCount;
};
