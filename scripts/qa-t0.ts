#!/usr/bin/env bun
/**
 * `bun run qa:t0` — T0 QA driver. Drives the built app through its GUI under
 * the e2e harness, checks every probe against deterministic two-witness
 * oracles, and folds the findings into test-results/qa-ledger.json.
 *
 *   attempt 1  the pairwise plan, chunked into shared launches
 *   attempt 2+3  every probe that saw a violation, each in a fresh launch
 *   ledger     one entry per fingerprint; confirmed when seen in 2 of 3
 *
 * No model is called. Findings never fail the command; only a harness that
 * could not run exits non-zero.
 *
 *   bun run qa:t0                  # build + full plan
 *   bun scripts/qa-t0.ts --only node:tasks   # reuse the current build, filter probe ids
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  foldFindings,
  mergeLedger,
  probesToRerun,
  type AttemptRecord,
  type Ledger,
  type RunSummary,
} from "../e2e/qa/ledger";
import { pairwisePlan, type Probe } from "../e2e/qa/pairwise";
import type { Chunk, ChunkFile } from "../e2e/qa/t0.spec";

const REPO_ROOT = join(import.meta.dir, "..");
const OUT_DIR = join(REPO_ROOT, "test-results", "qa-t0");
const LEDGER_PATH = join(REPO_ROOT, "test-results", "qa-ledger.json");
const CHUNK_SIZE = 8;

const argValue = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const only = argValue("--only");

const chunkBy = (probes: ReadonlyArray<Probe>, size: number, prefix: string): Chunk[] => {
  const byScale = new Map<number, Probe[]>();
  for (const probe of probes) byScale.set(probe.scale, [...(byScale.get(probe.scale) ?? []), probe]);
  const chunks: Chunk[] = [];
  for (const [scale, group] of [...byScale].sort(([a], [b]) => a - b)) {
    for (let i = 0; i < group.length; i += size) {
      chunks.push({ id: `${prefix}-s${scale}-c${String(i / size + 1).padStart(2, "0")}`, scale, probes: group.slice(i, i + size) });
    }
  }
  return chunks;
};

const runAttempt = (attempt: number, chunks: ReadonlyArray<Chunk>): { records: AttemptRecord[]; missing: string[] } => {
  const dir = join(OUT_DIR, `attempt-${attempt}`);
  mkdirSync(dir, { recursive: true });
  const chunkFile = join(OUT_DIR, `chunks-${attempt}.json`);
  const file: ChunkFile = { attempt, outDir: OUT_DIR, chunks };
  writeFileSync(chunkFile, `${JSON.stringify(file, null, 2)}\n`);
  console.log(`qa:t0: attempt ${attempt}: ${chunks.length} launches, ${chunks.reduce((n, c) => n + c.probes.length, 0)} probes`);
  const playwright = spawnSync(join(REPO_ROOT, "scripts/run-e2e.sh"), ["e2e/qa/t0.spec.ts"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env, JUNTO_E2E_CONFIG: "e2e/qa/playwright.config.ts", QA_T0_CHUNKS: chunkFile },
  });
  const records: AttemptRecord[] = [];
  const missing: string[] = [];
  if (playwright.status !== 0) {
    // Records are written before teardown, so a non-zero exit with every chunk
    // present means a launch or teardown fault, not lost probes. Keep it visible.
    missing.push(`attempt ${attempt}: playwright exited ${playwright.status ?? playwright.signal}`);
  }
  for (const chunk of chunks) {
    const path = join(dir, `${chunk.id}.json`);
    if (!existsSync(path)) {
      missing.push(`attempt ${attempt} ${chunk.id}: no records (harness failed before the chunk ran)`);
      continue;
    }
    records.push(...(JSON.parse(readFileSync(path, "utf8")) as AttemptRecord[]));
  }
  return { records, missing };
};

const gitCommit = (): string => {
  const head = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout.trim();
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout.trim() !== "";
  return dirty ? `${head}+dirty` : head;
};

const main = (): void => {
  const startedAt = new Date();
  for (const entry of existsSync(OUT_DIR) ? readdirSync(OUT_DIR) : []) {
    rmSync(join(OUT_DIR, entry), { recursive: true, force: true });
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const plan = pairwisePlan();
  const probes = only ? plan.probes.filter((probe) => probe.id.includes(only)) : plan.probes;
  writeFileSync(join(OUT_DIR, "plan.json"), `${JSON.stringify({ ...plan, probes }, null, 2)}\n`);
  console.log(
    `qa:t0: ${probes.length} probes cover ${plan.pairsCovered} value pairs (full cross product: ${plan.fullCrossProduct})`,
  );

  const first = runAttempt(1, chunkBy(probes, CHUNK_SIZE, "a1"));
  const records = [...first.records];
  const missing = [...first.missing];

  const rerunIds = new Set(probesToRerun(first.records));
  const probeById = new Map(probes.map((probe) => [probe.id, probe] as const));
  const rerunChunks: Chunk[] = [];
  for (const id of [...rerunIds].sort()) {
    const probe = probeById.get(id);
    const safe = id.replace(/[^\w.-]+/g, "_");
    if (probe) rerunChunks.push({ id: `r-${safe}`, scale: probe.scale, probes: [probe] });
    else if (id.startsWith("board/")) {
      // A board-level finding reruns as a bare launch: the settle check alone.
      const scale = Number(id.split("/")[3] ?? "1");
      rerunChunks.push({ id: `r-${safe}`, scale, probes: [] });
    }
  }
  for (const attempt of [2, 3]) {
    if (rerunChunks.length === 0) break;
    const rerun = runAttempt(attempt, rerunChunks);
    records.push(...rerun.records);
    missing.push(...rerun.missing);
  }

  const finishedAt = new Date();
  const now = finishedAt.toISOString();
  const findings = foldFindings(records, now);
  const firstAttempt = records.filter((record) => record.attempt === 1);
  const run: RunSummary = {
    runId: `qa-t0-${startedAt.toISOString()}`,
    startedAt: startedAt.toISOString(),
    finishedAt: now,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    commit: gitCommit(),
    plan: { probes: probes.length, fullCrossProduct: plan.fullCrossProduct, pairsCovered: plan.pairsCovered },
    probeExecutions: records.length,
    probesClean: firstAttempt.filter((record) => record.violations.length === 0).length,
    findings: {
      total: findings.length,
      confirmed: findings.filter((finding) => finding.status === "confirmed").length,
      flaky: findings.filter((finding) => finding.status === "flaky").length,
      new: 0,
    },
    harnessFailures: missing,
  };
  const prior = existsSync(LEDGER_PATH) ? (JSON.parse(readFileSync(LEDGER_PATH, "utf8")) as Ledger) : undefined;
  const { ledger, newCount } = mergeLedger(prior, run, findings, now);
  writeFileSync(LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`);

  console.log("");
  console.log(`qa:t0: ${(run.durationMs / 1000).toFixed(0)}s, ${run.probeExecutions} probe executions, ${run.probesClean}/${firstAttempt.length} clean on attempt 1`);
  console.log(`qa:t0: ${run.findings.confirmed} confirmed, ${run.findings.flaky} flaky, ${newCount} new -> ${LEDGER_PATH}`);
  for (const finding of findings.filter((f) => f.status === "confirmed").slice(0, 10)) {
    console.log(`  ${finding.fingerprint} ${finding.invariant} ${finding.surface}/${finding.action}: ${finding.signature}`);
  }
  for (const failure of missing) console.error(`qa:t0: harness: ${failure}`);
  const lostProbes = missing.some((failure) => failure.includes("no records"));
  process.exit(lostProbes ? 1 : 0);
};

main();
