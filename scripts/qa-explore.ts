#!/usr/bin/env bun
/**
 * `bun run qa:explore --budget N` — exploratory QA of the packaged Junto.app
 * in the jev-use pattern (Cua Driver + TypeSafe Jev,
 * ~/Projects/cua/libs/cua-driver/examples/jev-use).
 *
 * Each step:
 *   1. observe the window through Cua Driver (AX tree, no screenshot bytes);
 *   2. build an immutable candidate table from the QA registry and the live
 *      observation: every candidate carries its complete driver action, plus
 *      the reserved `reobserve` and `abstain`;
 *   3. ask Jev one Choice question; an id outside the table is rejected;
 *   4. execute exactly one driver action;
 *   5. re-observe and verify with two witnesses: the screen (AX text) and the
 *      app's own document read through its control socket.
 *
 * A step that sees a violation is replayed twice (the 2-of-3 flake gate), and
 * findings fold into test-results/qa-ledger.json by fingerprint. Candidates
 * are read-only by construction: nothing here creates, deletes, flags, or
 * starts anything. Replays do not spend the budget.
 *
 *   TYPESAFE_API_KEY=... bun run qa:explore --budget 20
 *   bun scripts/qa-explore.ts --budget 10 --mock      # no key: first untried candidate
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CuaDriver, type Json } from "../e2e/qa/cua";
import { foldFindings, writeRun, type AttemptRecord, type RunSummary } from "../e2e/qa/ledger";
import { normalizeText, readWitnessAt, type AppWitness, type Violation } from "../e2e/qa/oracle";
import {
  appVersion,
  makeRoot,
  PackagedApp,
  resolveTargetApp,
  seedScene,
  windowIds,
  type AxElement,
  type Observation,
} from "../e2e/qa/packaged";
import { QA_CANVAS, SURFACES } from "../e2e/qa/registry";

const REPO_ROOT = join(import.meta.dir, "..");
// Run artifacts live outside test-results/: any Playwright run in the shared
// worktree empties that directory at start, even mid-run.
const OUT_DIR = mkdtempSync("/tmp/junto-qa-explore-");
const LEDGER_PATH = join(REPO_ROOT, "test-results", "qa-ledger.json");
const JEV_URL = `${(process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai").replace(/\/+$/, "")}/v1/systemone`;
const JEV_MODEL = process.env.TYPESAFE_DEFAULT_MODEL ?? "jev-latest";
const MAX_CANDIDATES = 32;
const MIN_CONFIDENCE = 0.15;
const MAX_TRIES_PER_CANDIDATE = 2;
const GOAL =
  "Explore the Junto desktop app to find defects. Prefer the candidate most likely to expose a broken surface that has not been tried yet; avoid repeating what history shows was already verified.";

const argValue = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const budget = Number(argValue("--budget") ?? "20");
const mock = process.argv.includes("--mock");

// --- candidates --------------------------------------------------------------------

type Effect = "select-node" | "select-edge" | "open" | "shell" | "menu" | "dismiss";

interface Candidate {
  readonly id: string;
  readonly description: string;
  readonly surface: string;
  readonly action: string;
  readonly effect: Effect;
  /** Node id for a node selection, used by the parity check. */
  readonly nodeId?: string;
  readonly run: (app: PackagedApp) => Promise<Json>;
}

const READ_ONLY_SHELL: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/^Add canvas item$/, "shell:palette", "Open the add-item deck (read only: nothing is added)"],
  [/^Open settings$/, "shell:settings", "Open the settings panel"],
  [/^Search /, "shell:search", "Open node search"],
  [/^Fit all nodes$/, "shell:fit-all", "Fit every node into view"],
  [/^Zoom In$/, "shell:zoom-in", "Zoom the canvas in"],
  [/^Zoom Out$/, "shell:zoom-out", "Zoom the canvas out"],
];

const READ_ONLY_MENUS: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/^About\b/, "menu:about", "Open the About panel from the app menu"],
  [/^Reload$/, "menu:view-reload", "Reload the window from the View menu"],
  [/^Actual Size$/, "menu:actual-size", "Reset page zoom from the View menu"],
  [/^Zoom In$/, "menu:zoom-in", "Zoom the page in from the View menu"],
  [/^Zoom Out$/, "menu:zoom-out", "Zoom the page out from the View menu"],
];

const inWindow = (element: AxElement, window: AxElement | undefined): boolean => {
  const f = element.frame;
  const w = window?.frame;
  if (!f || !w || f.w < 4 || f.h < 4) return false;
  return f.x >= w.x && f.y >= w.y && f.x + f.w <= w.x + w.w && f.y + f.h <= w.y + w.h;
};

const buildCandidates = (observation: Observation, witness: AppWitness, selectedSurface: string | undefined): Candidate[] => {
  const { elements } = observation;
  const window = elements.find((e) => e.role === "AXWindow");
  const out: Candidate[] = [];

  // Nodes: registry node surfaces whose digest title is on screen.
  for (const surface of SURFACES.filter((s) => s.kind === "node")) {
    const node = witness.doc.nodes.find((n) => n.id === surface.target);
    const title = surface.target ? witness.titles.get(surface.target) : undefined;
    if (!node || !title) continue;
    const wanted = new Set([normalizeText(title)]);
    if (node.type === "link") {
      try {
        wanted.add(normalizeText(new URL(title).host));
      } catch {
        // not a URL
      }
    }
    const kindLabel = node.ether?.entity?.kind ?? "";
    const target =
      elements.find((e) => e.role === "AXStaticText" && wanted.has(normalizeText(e.label ?? "")) && inWindow(e, window)) ??
      elements.find((e) => e.role === "AXStaticText" && normalizeText(e.label ?? "") === normalizeText(kindLabel) && inWindow(e, window));
    if (!target) continue;
    out.push({
      id: `select-${surface.id.replace(/[^a-z0-9]+/gi, "-")}`,
      description: `Select the ${kindLabel || "note"} node "${title}" and read the command bar`,
      surface: surface.id,
      action: "select",
      effect: "select-node",
      nodeId: node.id,
      run: (app) => app.pointerClick(target),
    });
  }

  // Edges: the canvas exposes one "Select edge - <phase> - ..." button per wire.
  // Their AX order is not document order, so a wire is named by position and
  // phase, which is stable for the seeded scene.
  const edgeButtons = elements.filter((e) => e.role === "AXButton" && /^Select edge\b/.test(e.label ?? ""));
  edgeButtons.forEach((button, index) => {
    const phase = (button.label ?? "").split(" - ")[1] ?? "wire";
    const surface = `edge:${index + 1}-${phase}`;
    out.push({
      id: `select-${surface.replace(/[^a-z0-9]+/gi, "-")}`,
      description: `Select the wire "${button.label}"`,
      surface,
      action: "select",
      effect: "select-edge",
      run: (app) => app.press(button),
    });
  });

  // Detail surfaces the command bar offers for the current selection.
  for (const button of elements.filter((e) => e.role === "AXButton" && /^Open\b/.test(e.label ?? "") && e.label !== "Open settings")) {
    const surface = selectedSurface ?? "rts";
    out.push({
      id: `${surface.replace(/[^a-z0-9]+/gi, "-")}-${normalizeText(button.label!).replace(/[^a-z0-9]+/g, "-")}`,
      description: `${button.label} for the selected item`,
      surface,
      action: "open",
      effect: "open",
      run: (app) => app.press(button),
    });
  }

  for (const [pattern, surface, description] of READ_ONLY_SHELL) {
    const button = elements.find((e) => e.role === "AXButton" && pattern.test(e.label ?? ""));
    if (!button) continue;
    out.push({ id: surface.replace(":", "-"), description, surface, action: "press", effect: "shell", run: (app) => app.press(button) });
  }

  for (const [pattern, surface, description] of READ_ONLY_MENUS) {
    const entry = observation.menus.find((m) => pattern.test(m.label) && m.enabled);
    if (!entry) continue;
    out.push({
      id: surface.replace(":", "-"),
      description,
      surface,
      action: "invoke",
      effect: "menu",
      run: (app) => app.invokeMenu([entry.menu, entry.label]),
    });
  }

  out.push({ id: "dismiss", description: "Press Escape to close whatever is open", surface: "shell:escape", action: "press", effect: "dismiss", run: (app) => app.pressEscape() });
  return out;
};

// --- Jev ------------------------------------------------------------------------------

interface Choice {
  readonly id: string;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly ms: number;
  readonly tokens?: unknown;
}

/** One Choice over the table; the key is read from the environment and never logged. */
const chooseWithJev = async (
  key: string,
  table: ReadonlyArray<{ id: string; description: string }>,
  observation: Json,
  history: ReadonlyArray<Json>,
): Promise<Choice> => {
  const criteria = Object.fromEntries(table.map((candidate) => [candidate.id, candidate.description]));
  const started = Date.now();
  const response = await fetch(JEV_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      model: JEV_MODEL,
      state: { goal: GOAL, observation: JSON.stringify(observation), history: JSON.stringify(history) },
      questions: { candidate: { type: "choice", instructions: "Which candidate should the QA runner execute next?", criteria } },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Jev HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const body = (await response.json()) as {
    answers?: { candidate?: { type?: string; choice?: string; confidence?: number; probabilities?: Record<string, number> } };
    usage?: unknown;
  };
  const answer = body.answers?.candidate;
  if (answer?.type !== "choice" || typeof answer.choice !== "string" || !Object.hasOwn(criteria, answer.choice)) {
    throw new Error(`Jev returned no valid candidate: ${JSON.stringify(answer).slice(0, 200)}`);
  }
  return {
    id: answer.choice,
    confidence: Number(answer.confidence ?? 0),
    probabilities: answer.probabilities ?? {},
    ms: Date.now() - started,
    tokens: body.usage,
  };
};

/** Jev sheds load with 429/5xx; retry those with backoff, then give up so the run still writes its ledger. */
const chooseWithRetry = async (
  key: string,
  table: ReadonlyArray<{ id: string; description: string }>,
  observation: Json,
  history: ReadonlyArray<Json>,
): Promise<Choice> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await chooseWithJev(key, table, observation, history);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= 3 || !/HTTP (429|5\d\d)|timed? ?out|abort/i.test(message)) throw error;
      await Bun.sleep(2_000 * 2 ** attempt);
    }
  }
};

// --- verification -------------------------------------------------------------------

const LEAKS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\u00b7/, "middle dot"],
  [/\bundefined\b/, "undefined"],
  [/\bNaN\b/, "NaN"],
  [/\[object Object\]/, "[object Object]"],
];

const verify = async (
  app: PackagedApp,
  candidate: Candidate,
  before: { observation: Observation; witness: AppWitness; windows: Set<number>; ownWindows: number },
): Promise<Violation[]> => {
  const out: Violation[] = [];
  if (!app.alive()) {
    return [{ invariant: "app-alive", signature: `${candidate.id} killed the app`, detail: "process exited after the action" }];
  }
  const after = await app.observe();
  const joined = after.texts.join("\n");
  for (const [pattern, name] of LEAKS) {
    const match = pattern.exec(joined);
    if (match) {
      out.push({
        invariant: "copy-law",
        signature: `${candidate.surface}: ${name}`,
        detail: `"${joined.slice(Math.max(0, match.index - 40), match.index + 40).replace(/\s+/g, " ")}"`,
      });
    }
  }
  const witness = await readWitnessAt(app.home, QA_CANVAS);
  if (witness.docHash !== before.witness.docHash) {
    out.push({
      invariant: "doc-unchanged",
      signature: `${candidate.surface}/${candidate.action} mutated the document`,
      detail: `${before.witness.docHash.slice(0, 12)} -> ${witness.docHash.slice(0, 12)}`,
    });
  }
  const labels = after.elements.map((e) => normalizeText(e.label ?? ""));
  const beforeLabels = new Set(before.observation.elements.map((e) => `${e.role}|${e.label ?? ""}`));
  const fresh = after.elements.filter((e) => !beforeLabels.has(`${e.role}|${e.label ?? ""}`));
  if (candidate.effect === "select-node" && candidate.nodeId) {
    // Two witnesses: the document's kind for this node vs the command bar's toolbar.
    const kind = witness.doc.nodes.find((n) => n.id === candidate.nodeId)?.ether?.entity?.kind;
    const toolbar = after.elements.find((e) => e.role === "AXToolbar" && / actions$/.test(e.label ?? "") && e.label !== "Node actions");
    if (!toolbar) {
      out.push({ invariant: "surface-appears", signature: `${candidate.surface}: no command bar`, detail: "no kind toolbar after selecting" });
    } else if (kind && normalizeText(toolbar.label!) !== `${kind} actions`) {
      out.push({
        invariant: "selection-parity",
        signature: `${candidate.surface}: command bar names a different kind`,
        detail: `document kind "${kind}", command bar "${toolbar.label}"`,
      });
    }
  }
  if (candidate.effect === "select-edge" && !labels.includes("relation")) {
    out.push({ invariant: "surface-appears", signature: `${candidate.surface}: no relation strip`, detail: "no Relation toolbar after selecting the wire" });
  }
  if ((candidate.effect === "open" || candidate.surface === "shell:palette" || candidate.surface === "shell:settings") && fresh.length < 3) {
    out.push({
      invariant: "surface-appears",
      signature: `${candidate.surface}/${candidate.action}: nothing opened`,
      detail: `${fresh.length} new AX elements after ${candidate.id}`,
    });
  }
  if (candidate.surface === "menu:about") {
    const ownWindows = (await app.windows()).filter((w) => w.is_on_screen && w.bounds.height > 60).length;
    if (ownWindows <= before.ownWindows) {
      out.push({ invariant: "surface-appears", signature: "menu:about: no panel", detail: "About opened no window" });
    }
  }
  for (const prompt of await app.promptsSince(before.windows)) {
    out.push({ invariant: "no-os-prompt", signature: `${candidate.surface}: ${prompt.app} prompt names Junto`, detail: `${prompt.title}: ${prompt.text}` });
  }
  return out;
};

/** Close About panels and overlays, then fit the canvas, so every step starts from the board. */
const settle = async (app: PackagedApp): Promise<void> => {
  for (const window of await app.windows()) {
    if (window.window_id !== app.windowId && window.is_on_screen && window.bounds.height > 60) {
      await app.driver.call("hotkey", { pid: app.pid, window_id: window.window_id, keys: ["cmd", "w"], delivery_mode: "foreground" }).catch(() => {});
    }
  }
  await app.pressEscape().catch(() => {});
  await app.pressEscape().catch(() => {});
  const fit = (await app.observe()).elements.find((e) => e.role === "AXButton" && e.label === "Fit all nodes");
  if (fit) await app.press(fit).catch(() => {});
  await Bun.sleep(400);
};

const compactObservation = (observation: Observation, selectedSurface: string | undefined): Json => ({
  selected: selectedSurface ?? null,
  toolbars: observation.elements.filter((e) => e.role === "AXToolbar").map((e) => e.label),
  visibleText: [...new Set(observation.texts)].slice(0, 80),
});

// --- main --------------------------------------------------------------------------

const main = async (): Promise<void> => {
  const key = process.env.TYPESAFE_API_KEY ?? "";
  if (!mock && key === "") {
    console.error("qa:explore: TYPESAFE_API_KEY is not set; pass --mock to run without Jev");
    process.exit(2);
  }
  if (!Number.isInteger(budget) || budget < 1) {
    console.error("qa:explore: --budget must be a positive integer");
    process.exit(2);
  }
  const startedAt = new Date();
  console.log(`qa:explore: run artifacts in ${OUT_DIR}`);
  const steps = join(OUT_DIR, "steps.jsonl");
  const target = argValue("--app") ? { path: argValue("--app")!, reason: "--app" } : resolveTargetApp(REPO_ROOT);
  console.log(`qa:explore: ${target.path} ${appVersion(target.path)} (${target.reason}); budget ${budget}, ${mock ? "mock chooser" : `Jev ${JEV_MODEL}`}`);

  const root = makeRoot("explore");
  seedScene(REPO_ROOT, root);
  const driver = await CuaDriver.connect("junto-qa-explore");
  const records: AttemptRecord[] = [];
  const tries = new Map<string, number>();
  const history: Json[] = [];
  const jevMs: number[] = [];
  let decisions = 0;
  let jevFailure: string | undefined;
  let app: PackagedApp | undefined;
  try {
    app = await PackagedApp.launch(driver, target.path, root);
    await Bun.sleep(3_000);
    await settle(app);
    let selectedSurface: string | undefined;

    // The candidate must be built from `observation`: a newer AX snapshot makes
    // its element tokens stale, so nothing here may re-observe before acting.
    const execute = async (candidate: Candidate, attempt: number, observation: Observation): Promise<AttemptRecord> => {
      const started = Date.now();
      const before = {
        observation,
        witness: await readWitnessAt(app!.home, QA_CANVAS),
        windows: await windowIds(driver),
        ownWindows: (await app!.windows()).filter((w) => w.is_on_screen && w.bounds.height > 60).length,
      };
      let violations: Violation[];
      try {
        await candidate.run(app!);
        await Bun.sleep(700);
        violations = await verify(app!, candidate, before);
      } catch (error) {
        const message = error instanceof Error ? error.message.split("\n")[0]! : String(error);
        violations = [{ invariant: "probe-error", signature: message.slice(0, 200), detail: message }];
      }
      return {
        tier: "explore",
        attempt,
        probeId: candidate.id,
        surface: candidate.surface,
        action: candidate.action,
        context: { theme: "system", scale: 0, viewport: "packaged" },
        durationMs: Date.now() - started,
        violations,
      };
    };

    while (decisions < budget && app.alive()) {
      const observation = await app.observe();
      const witness = await readWitnessAt(app.home, QA_CANVAS);
      const table = buildCandidates(observation, witness, selectedSurface)
        .filter((candidate) => (tries.get(candidate.id) ?? 0) < MAX_TRIES_PER_CANDIDATE)
        .slice(0, MAX_CANDIDATES - 2);
      const reserved = [
        { id: "reobserve", description: "Look again without acting" },
        { id: "abstain", description: "Stop exploring: nothing useful is left to try" },
      ];
      if (table.length === 0) break;
      const listing = [...table.map(({ id, description }) => ({ id, description })), ...reserved];
      let choice: Choice;
      if (mock) {
        const pick = table.find((candidate) => !tries.has(candidate.id)) ?? table[0]!;
        choice = { id: pick.id, confidence: 1, probabilities: {}, ms: 0 };
      } else {
        try {
          choice = await chooseWithRetry(key, listing, compactObservation(observation, selectedSurface), history.slice(-8));
        } catch (error) {
          jevFailure = error instanceof Error ? error.message : String(error);
          console.error(`qa:explore: stopping early: ${jevFailure}`);
          break;
        }
        jevMs.push(choice.ms);
      }
      decisions += 1;
      const top = Object.entries(choice.probabilities).sort(([, a], [, b]) => b - a).slice(0, 3);
      if (choice.id === "abstain") {
        appendFileSync(steps, `${JSON.stringify({ step: decisions, table: listing.length, choice: choice.id, confidence: choice.confidence, top, jevMs: choice.ms })}\n`);
        break;
      }
      const candidate = table.find((c) => c.id === choice.id);
      if (choice.id === "reobserve" || !candidate || choice.confidence < MIN_CONFIDENCE) {
        appendFileSync(steps, `${JSON.stringify({ step: decisions, table: listing.length, choice: choice.id, confidence: choice.confidence, top, jevMs: choice.ms, outcome: "reobserve" })}\n`);
        history.push({ step: decisions, candidate: choice.id, outcome: "reobserved" });
        continue;
      }
      tries.set(candidate.id, (tries.get(candidate.id) ?? 0) + 1);
      const record = await execute(candidate, 1, observation);
      records.push(record);
      if (candidate.effect === "select-node" || candidate.effect === "select-edge") selectedSurface = candidate.surface;
      if (candidate.effect === "dismiss") selectedSurface = undefined;
      const outcome = record.violations.length === 0 ? "verified" : `violations: ${record.violations.map((v) => v.invariant).join(", ")}`;
      history.push({ step: decisions, candidate: candidate.id, outcome });
      appendFileSync(
        steps,
        `${JSON.stringify({ step: decisions, table: listing.length, choice: candidate.id, confidence: choice.confidence, top, jevMs: choice.ms, actionMs: record.durationMs, outcome, violations: record.violations })}\n`,
      );
      console.log(`qa:explore: ${decisions}/${budget} ${candidate.id} (${choice.confidence.toFixed(2)}) -> ${outcome}`);

      if (record.violations.length > 0) {
        // Flake gate: the same candidate twice more, each from a settled board.
        for (const attempt of [2, 3]) {
          await settle(app);
          if (candidate.effect === "open" && selectedSurface) {
            const select = buildCandidates(await app.observe(), await readWitnessAt(app.home, QA_CANVAS), undefined).find(
              (c) => c.surface === selectedSurface && c.action === "select",
            );
            if (select) await select.run(app).catch(() => {});
            await Bun.sleep(500);
          }
          const fresh = await app.observe();
          const replay = buildCandidates(fresh, await readWitnessAt(app.home, QA_CANVAS), selectedSurface).find(
            (c) => c.id === candidate.id,
          );
          if (replay) records.push(await execute(replay, attempt, fresh));
        }
        await settle(app);
        selectedSurface = undefined;
      }
    }
  } finally {
    await app?.quit().catch(() => undefined);
    await driver.close();
    rmSync(root, { recursive: true, force: true });
  }

  const finishedAt = new Date();
  const now = finishedAt.toISOString();
  const findings = foldFindings(records, now);
  const first = records.filter((record) => record.attempt === 1);
  const head = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout.trim();
  const run: RunSummary = {
    tier: "explore",
    runId: `qa-explore-${startedAt.toISOString()}`,
    startedAt: startedAt.toISOString(),
    finishedAt: now,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    commit: `${head} (app ${appVersion(target.path)} at ${target.path}; ${mock ? "mock" : JEV_MODEL}; ${decisions} decisions)`,
    plan: { probes: first.length, fullCrossProduct: 0, pairsCovered: 0 },
    probeExecutions: records.length,
    probesClean: first.filter((record) => record.violations.length === 0).length,
    findings: {
      total: findings.length,
      confirmed: findings.filter((f) => f.status === "confirmed").length,
      flaky: findings.filter((f) => f.status === "flaky").length,
      new: 0,
    },
    harnessFailures: jevFailure ? [`Jev unavailable after ${decisions} decisions: ${jevFailure}`] : [],
  };
  const newCount = writeRun(LEDGER_PATH, run, findings, now);
  const sorted = [...jevMs].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length / 2)];
  console.log(
    `\nqa:explore: ${(run.durationMs / 1000).toFixed(0)}s, ${decisions} decisions, ${new Set(first.map((r) => r.probeId)).size} distinct candidates, ${run.probesClean}/${first.length} clean${p50 === undefined ? "" : `, Jev p50 ${p50}ms`}`,
  );
  console.log(`qa:explore: ${run.findings.confirmed} confirmed, ${run.findings.flaky} flaky, ${newCount} new -> ${LEDGER_PATH}`);
  for (const finding of findings) {
    console.log(`  ${finding.status} ${finding.fingerprint} ${finding.invariant} ${finding.surface}/${finding.action}: ${finding.signature}`);
  }
};

await main();
