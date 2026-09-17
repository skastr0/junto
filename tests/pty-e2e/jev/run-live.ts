#!/usr/bin/env bun
/**
 * Runnable live entry point — the parent calls this with a key.
 *
 *   TYPESAFE_API_KEY=... bun tests/pty-e2e/jev/run-live.ts --split holdout
 *   bun tests/pty-e2e/jev/run-live.ts --split holdout --dry-run     # no key
 *
 * The key is read from `TYPESAFE_API_KEY` (preferred) or `--api-key`, and is
 * never printed. Nothing here is needed to run the repo's validation: the
 * unit suite exercises the request/response contract with an injected fetch
 * and never touches the network.
 *
 * Splits (see holdout.ts):
 *   tune            the parent's already-paid captures — a fit, not a score
 *   holdout         tier 1 + tier 2: what the paid runs must not be tuned on
 *   holdout-tier1   whole-harness `pi`
 *   holdout-tier2   the dialog/credential captures the tune set cannot test
 *   reserved        every capture the paid runs never sent
 *   all             everything with a committed capture
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HARNESSES } from "./chrome";
import { scenariosOf } from "./checkpoints";
import { allCapturesOf, capturesForSplit, SPLITS, type Split } from "./holdout";
import { questionPack, PACK_IDS, REQUESTED_MODEL, type QuestionMap } from "./pack";
import { renderMarkdown, runLiveComparison, stateForCheckpoints } from "./report";
import { DEFAULT_FRACTION_STEPS } from "./replay";
import { loadManifest } from "./manifest-file";
import type { Checkpoint, CheckpointClass } from "./types";

const here = dirname(fileURLToPath(import.meta.url));

const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const arg = (name: string, fallback?: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1]! : fallback;
};

const usage = (): string =>
  [
    "usage: bun tests/pty-e2e/jev/run-live.ts [options]",
    "",
    "  --split <name>          " + SPLITS.join(" | ") + "   (default: holdout)",
    "  --class <name>          live_turn | dialog | settled_idle (default: all)",
    "  --limit <n>             cap the number of paid calls",
    "  --concurrency <n>       parallel calls (default 4)",
    "  --model <id>            model field sent to the service (default: " + REQUESTED_MODEL + ")",
    "  --base-url <url>        API root (default: https://api.typesafe.ai)",
    "  --timeout-ms <n>        per-call timeout (default 20000)",
    "  --max-retries <n>       retries on 429/529 (default 2)",
    "  --fraction-steps <n>    replay grid resolution (default " + String(DEFAULT_FRACTION_STEPS) + ")",
    "  --out <path>            report basename; .json and .md are written",
    "  --dry-run               print the requests and write no paid call (no key needed)",
    "  --list                  list the checkpoints in the split and exit",
    "  --api-key <key>         else TYPESAFE_API_KEY",
    "  --help",
  ].join("\n");

const main = async (): Promise<void> => {
  if (flag("help")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const split = (arg("split", "holdout") ?? "holdout") as Split;
  if (!SPLITS.includes(split)) {
    process.stderr.write(`unknown split ${split}\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  const classFilter = arg("class") as CheckpointClass | undefined;
  const limit = arg("limit") === undefined ? undefined : Number(arg("limit"));
  const fractionSteps = Number(arg("fraction-steps", String(DEFAULT_FRACTION_STEPS)));

  const manifest = loadManifest();
  const captures = allCapturesOf(HARNESSES, scenariosOf);
  const inSplit = new Set(capturesForSplit(split, captures));
  const selected: readonly Checkpoint[] = manifest.checkpoints.filter(
    (checkpoint) =>
      inSplit.has(`${checkpoint.harness}/${checkpoint.scenario}`) &&
      (classFilter === undefined || checkpoint.class === classFilter),
  );

  process.stderr.write(
    `[jev] split=${split} class=${classFilter ?? "all"} captures=${inSplit.size} checkpoints=${selected.length}` +
      `${limit !== undefined ? ` (limit ${limit})` : ""}\n`,
  );

  if (selected.length === 0) {
    process.stderr.write("[jev] nothing to do\n");
    return;
  }

  if (flag("list")) {
    for (const checkpoint of selected) {
      process.stdout.write(
        `${checkpoint.id}\t${checkpoint.class}\tcut=${checkpoint.cut}\tprobe=${checkpoint.matches[0]?.probeId ?? "-"}\n`,
      );
    }
    return;
  }

  if (flag("dry-run")) {
    const states = await stateForCheckpoints(selected, { fractionSteps });
    for (const entry of states) {
      const questions: QuestionMap = questionPack(entry.ids);
      process.stdout.write(
        `${entry.checkpoint.id}\t${entry.checkpoint.class}\tlines=${entry.ids.length}\t` +
          `questions=${Object.keys(questions).length}\tevidence=${entry.state.evidence ? "pair" : "single"}\n`,
      );
    }
    process.stdout.write(
      `\npack ids: ${PACK_IDS.join(", ")}\n` +
        `model field that would be sent: ${REQUESTED_MODEL}\n` +
        `calls that would be made: ${Math.min(states.length, limit ?? states.length)}\n`,
    );
    return;
  }

  const apiKey = arg("api-key") ?? process.env.TYPESAFE_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    process.stderr.write(
      "no API key: set TYPESAFE_API_KEY or pass --api-key (use --dry-run to inspect without one)\n",
    );
    process.exitCode = 2;
    return;
  }

  const states = await stateForCheckpoints(selected, {
    fractionSteps,
    onProgress: (message) => process.stderr.write(`[jev] ${message}\n`),
  });
  const report = await runLiveComparison(states, {
    split,
    fractionSteps,
    apiKey,
    concurrency: Number(arg("concurrency", "4")),
    ...(arg("model") !== undefined ? { model: arg("model") } : {}),
    ...(arg("base-url") !== undefined ? { baseUrl: arg("base-url") } : {}),
    timeoutMs: Number(arg("timeout-ms", "20000")),
    maxRetries: Number(arg("max-retries", "2")),
    ...(limit !== undefined ? { limit } : {}),
    onProgress: (message) => process.stderr.write(`[jev] ${message}\n`),
  });

  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  const out =
    arg("out") ??
    join(here, "..", "..", "..", ".amp", "in", "artifacts", "jev-pty-poc", `compare-${split}-${stamp}`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.json`, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(`${out}.md`, `${renderMarkdown(report)}\n`);

  process.stdout.write(renderMarkdown(report));
  process.stderr.write(`\n[jev] wrote ${out}.json and ${out}.md\n`);
};

await main();
