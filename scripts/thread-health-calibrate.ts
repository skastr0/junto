/**
 * Thread-health calibration: a handful of labelled screens through the
 * PRODUCT's own request builder, Jev client and projection (not the harness
 * pack), so the numbers describe what ships.
 *
 *   TYPESAFE_API_KEY=… bun scripts/thread-health-calibrate.ts [--json out.json]
 *
 * One live call per case. Labels are fixed here before any call and were
 * written from the screen alone, never from model output. The screens are
 * constructed to the shape of real Claude Code sessions (they are not
 * captures), which is the limit of what this run can claim. The key is read
 * from the environment by the client and never printed.
 */

import { writeFileSync } from "node:fs";
import { Effect } from "effect";
import { makeAwarenessModel } from "../src/main/junto/term/awareness/jev-client";
import { AWARENESS_QUESTIONS } from "../src/main/junto/term/awareness/questions";
import { selectAwarenessInput } from "../src/main/junto/term/awareness/select-input";
import type { ThreadHealthValue } from "../src/shared/thread-health";

type Case = {
  readonly id: string;
  /** Expected headline; undefined means no reading is the right answer. */
  readonly label: ThreadHealthValue | undefined;
  readonly lines: readonly string[];
};

const PROMPT_BOX = ["", "╭──────────────────────────────────────────────╮", "│ >                                            │", "╰──────────────────────────────────────────────╯"];

const CASES: readonly Case[] = [
  {
    id: "waiting-prose-handback",
    label: "waiting_on_operator",
    lines: [
      "⏺ Migrated the auth service and the billing service to the new client.",
      "  Both build and their tests pass.",
      "",
      "  Three services are left: search, notifications, and export. Export",
      "  writes to the production bucket, so I stopped here.",
      "",
      "  Should I migrate the remaining three, or do you want to review the",
      "  first two before I touch export?",
      ...PROMPT_BOX,
    ],
  },
  {
    id: "finished-verified",
    label: "succeeding",
    lines: [
      "⏺ Bash(bun test tests/parser.test.ts)",
      "  ⎿  42 pass",
      "     0 fail",
      "",
      "⏺ Bash(git commit -m \"fix(parser): accept trailing commas\")",
      "  ⎿  [main 3f2a91c] fix(parser): accept trailing commas",
      "",
      "⏺ Done. The parser now accepts trailing commas in arrays and objects;",
      "  the new cases are covered and all 42 parser tests pass. Committed as",
      "  3f2a91c.",
      ...PROMPT_BOX,
    ],
  },
  {
    id: "stuck-retrying",
    label: "stuck",
    lines: [
      "⏺ Bash(bun install)",
      "  ⎿  error: ETIMEDOUT fetching https://registry.npmjs.org/effect",
      "⏺ The registry timed out. Retrying.",
      "⏺ Bash(bun install)",
      "  ⎿  error: ETIMEDOUT fetching https://registry.npmjs.org/effect",
      "⏺ Retrying the install again.",
      "⏺ Bash(bun install)",
      "  ⎿  error: ETIMEDOUT fetching https://registry.npmjs.org/effect",
      "⏺ Still timing out. Retrying once more.",
      "⏺ Bash(bun install)",
      "  ⎿  error: ETIMEDOUT fetching https://registry.npmjs.org/effect",
      "✻ Retrying… (esc to interrupt)",
    ],
  },
  {
    id: "thrashing-revert-cycle",
    label: "thrashing",
    lines: [
      "⏺ Update(src/cache.ts) switched the map to a WeakMap",
      "⏺ Bash(bun test tests/cache.test.ts)",
      "  ⎿  2 fail: keys must be objects",
      "⏺ That broke string keys. Reverting to the Map.",
      "⏺ Update(src/cache.ts) reverted to Map",
      "⏺ Bash(bun test tests/cache.test.ts)",
      "  ⎿  1 fail: entry leaked after release",
      "⏺ The leak is back. Switching to the WeakMap again, with a string wrapper.",
      "⏺ Update(src/cache.ts) switched the map to a WeakMap",
      "⏺ Bash(bun test tests/cache.test.ts)",
      "  ⎿  2 fail: keys must be objects",
      "⏺ Reverting the WeakMap change again.",
      "✻ Updating src/cache.ts… (esc to interrupt)",
    ],
  },
  {
    id: "confused-task",
    label: "confused",
    lines: [
      "⏺ I've updated the login page styles as requested.",
      "",
      "> no, I asked you to fix the login rate limiter, not the page",
      "",
      "⏺ Apologies, I misread that. Let me look at the styles for the rate",
      "  limiter page.",
      "⏺ Read(src/renderer/login.css)",
      "⏺ Actually, I'm not sure which rate limiter you mean; there is no page",
      "  for it. Sorry, let me re-read the task. I think you want the login",
      "  page to show a rate limit message, so I'll edit login.css again.",
      "✻ Thinking… (esc to interrupt)",
    ],
  },
  {
    id: "overwhelmed-context",
    label: "overwhelmed",
    lines: [
      "⏺ Bash(bun run typecheck)",
      "  ⎿  Found 214 errors in 63 files.",
      "⏺ There are a lot of errors across the codebase. The scope of this",
      "  migration is much larger than it looked; I'll skip the tests and the",
      "  docs for now and only fix the core files.",
      "⏺ Update(src/core/a.ts)",
      "⏺ Update(src/core/b.ts)",
      "",
      "  Context left until auto-compact: 3%",
      "✻ Compacting conversation… (esc to interrupt)",
    ],
  },
  {
    id: "going-well-plan",
    label: "going_well",
    lines: [
      "⏺ Step 2 of 5 done: the schema accepts the new field.",
      "⏺ Bash(bun test tests/schema.test.ts)",
      "  ⎿  18 pass",
      "     0 fail",
      "⏺ Step 3 of 5: wiring the field through the IPC handler.",
      "⏺ Update(src/main/ipc.ts)",
      "  ⎿  Updated src/main/ipc.ts with 12 additions",
      "⏺ Bash(bun test tests/ipc.test.ts)",
      "  ⎿  9 pass",
      "     0 fail",
      "✻ Step 4 of 5: renderer store… (esc to interrupt)",
    ],
  },
  {
    id: "steady-exploring",
    label: "steady",
    lines: [
      "⏺ Search(pattern: \"rateLimit\", path: \"src\")",
      "  ⎿  Found 6 files",
      "⏺ Read(src/main/auth/limiter.ts)",
      "  ⎿  Read 88 lines",
      "⏺ The limiter keys on the IP only. Next I'll read how the login",
      "  handler calls it.",
      "⏺ Read(src/main/auth/login.ts)",
      "  ⎿  Read 140 lines",
      "✻ Reading… (esc to interrupt)",
    ],
  },
  {
    id: "exceeding-extra-verified",
    label: "exceeding",
    lines: [
      "⏺ Bash(bun test)",
      "  ⎿  58 pass",
      "     0 fail",
      "⏺ Done. The date picker now respects the locale's first day of week.",
      "",
      "  Beyond the ask: while testing I found an off-by-one in",
      "  src/lib/calendar.ts that dropped the last day of February in leap",
      "  years. I fixed it and added 6 edge-case tests (leap years, DST",
      "  boundaries, week 53). All 58 tests pass, typecheck is clean, and",
      "  it is committed as 91be0c2.",
      ...PROMPT_BOX,
    ],
  },
  {
    id: "approval-menu",
    label: "waiting_on_operator",
    lines: [
      "⏺ Bash(rm -rf dist && bun run build)",
      "",
      "╭──────────────────────────────────────────────────────────────╮",
      "│ Bash command                                                 │",
      "│                                                              │",
      "│   rm -rf dist && bun run build                               │",
      "│                                                              │",
      "│ Do you want to proceed?                                      │",
      "│ ❯ 1. Yes                                                     │",
      "│   2. Yes, and don't ask again for this command               │",
      "│   3. No, and tell Claude what to do differently (esc)        │",
      "╰──────────────────────────────────────────────────────────────╯",
    ],
  },
];

const healthIds = AWARENESS_QUESTIONS.filter((q) => q.kind === "noul" && q.health !== undefined).map(
  (q) => q.id,
);

const run = async (): Promise<void> => {
  const model = makeAwarenessModel({ apiKey: process.env.TYPESAFE_API_KEY });
  if (!model.available) {
    console.log("thread-health calibration: skipped, no key configured");
    return;
  }
  const rows: unknown[] = [];
  let agree = 0;
  let inputTokens = 0;
  for (const [index, entry] of CASES.entries()) {
    const request = selectAwarenessInput({
      bindingId: `cal-${entry.id}`,
      epoch: "e1",
      cols: 80,
      rows: Math.max(24, entry.lines.length),
      seq: BigInt(index + 1),
      lines: [...entry.lines],
      totalLines: entry.lines.length,
      truncated: false,
      observedAt: Date.now(),
    });
    const started = performance.now();
    const outcome = await Effect.runPromise(
      model.ask({ request, harness: "claude" }, new AbortController().signal),
    );
    const ms = Math.round(performance.now() - started);
    inputTokens += outcome.usage?.inputTokens ?? 0;
    const assessment = outcome.assessment;
    const probability = new Map<string, number>();
    for (const signal of assessment.health?.signals ?? []) probability.set(signal.questionId, signal.probability);
    for (const negative of assessment.negatives) probability.set(negative.questionId, negative.probability);
    for (const abstention of assessment.abstentions) {
      if (abstention.probability !== undefined) probability.set(abstention.questionId, abstention.probability);
    }
    const headline = assessment.health?.value;
    const ok = headline === entry.label;
    if (ok) agree += 1;
    rows.push({
      id: entry.id,
      label: entry.label ?? null,
      headline: headline ?? null,
      agree: ok,
      availability: assessment.availability,
      failure: outcome.failure?.kind ?? null,
      model: assessment.provenance.returnedModel ?? null,
      ms,
      signals: assessment.health?.signals.map((s) => `${s.value} ${s.probability.toFixed(2)}`) ?? [],
      healthProbabilities: Object.fromEntries(healthIds.map((id) => [id, probability.get(id) ?? null])),
      concerns: assessment.concerns.map((c) => `${c.concern} ${c.probability.toFixed(2)}`),
    });
    console.log(
      `${ok ? "ok  " : "MISS"} ${entry.id.padEnd(26)} label=${String(entry.label).padEnd(20)} read=${String(headline).padEnd(20)} ${ms}ms`,
    );
  }
  console.log(`\nagreement ${agree}/${CASES.length}, input tokens ${inputTokens}`);
  const out = process.argv.indexOf("--json");
  if (out !== -1 && process.argv[out + 1]) {
    writeFileSync(
      process.argv[out + 1]!,
      `${JSON.stringify({ at: new Date().toISOString(), agree, total: CASES.length, inputTokens, rows }, null, 2)}\n`,
    );
  }
};

void run();
