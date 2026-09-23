#!/usr/bin/env bun
/**
 * `bun run qa:t1` — scripted Cua Driver checks of the packaged Junto.app, for
 * the surfaces only a packaged build has: first launch into an empty home,
 * the native menu bar, the About panel, macOS permission prompts Junto itself
 * causes, reload, and quit + relaunch. No model is called.
 *
 * One `cua-driver mcp` connection serves the whole run, with the agent cursor
 * overlay off. The app runs from a throwaway HOME under /tmp. Findings fold
 * into test-results/qa-ledger.json with the same fingerprints and 2-of-3
 * flake gate as qa:t0: when attempt 1 sees anything, the whole sequence runs
 * twice more on fresh roots.
 *
 * Target: release/mac-arm64/Junto.app when it is newer than HEAD, otherwise
 * the installed /Applications/Junto.app, used read-only. Builds nothing.
 * Clicks use foreground delivery, so the app window briefly comes to the front.
 *
 *   bun run qa:t1
 *   bun scripts/qa-t1.ts --app /path/to/Junto.app
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CuaDriver } from "../e2e/qa/cua";
import { foldFindings, writeRun, type AttemptRecord, type RunSummary } from "../e2e/qa/ledger";
import { listCanvasesAt, normalizeText, readWitnessAt, type Violation } from "../e2e/qa/oracle";
import {
  appVersion,
  LaunchError,
  makeRoot,
  PackagedApp,
  resolveTargetApp,
  seedScene,
  windowIds,
  type Observation,
} from "../e2e/qa/packaged";
import { QA_CANVAS } from "../e2e/qa/registry";

const REPO_ROOT = join(import.meta.dir, "..");
// Run artifacts live outside test-results/: any Playwright run in the shared
// worktree empties that directory at start, even mid-run.
const OUT_DIR = mkdtempSync("/tmp/junto-qa-t1-");
const LEDGER_PATH = join(REPO_ROOT, "test-results", "qa-ledger.json");
const PROMPT_WINDOW_MS = 8_000;
const PRODUCT = "Junto";

const argValue = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

// --- invariants over one observation ---------------------------------------------

const LEAKS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\u00b7/, "middle dot"],
  [/\bundefined\b/, "undefined"],
  [/\bNaN\b/, "NaN"],
  [/\[object Object\]/, "[object Object]"],
];

const copyLaw = (scope: string, texts: ReadonlyArray<string>): Violation[] => {
  const joined = texts.join("\n");
  return LEAKS.flatMap(([pattern, name]) => {
    const match = pattern.exec(joined);
    if (!match) return [];
    const excerpt = joined.slice(Math.max(0, match.index - 40), match.index + 40).replace(/\s+/g, " ");
    return [{ invariant: "copy-law", signature: `${scope}: ${name}`, detail: `"${excerpt}"` }];
  });
};

/**
 * The product name is spelled Junto wherever the app shows it. All caps is
 * allowed: AX reports CSS-uppercased text as rendered.
 */
const productName = (scope: string, texts: ReadonlyArray<string>): Violation[] => {
  const misspelled = (text: string): boolean =>
    [...text.matchAll(/junto/gi)].some(([match]) => match !== "Junto" && match !== "JUNTO");
  const wrong = [...new Set(texts.filter(misspelled))];
  return wrong.length === 0
    ? []
    : [
        {
          invariant: "product-name",
          signature: `${scope}: product name not spelled ${PRODUCT}`,
          detail: wrong.slice(0, 8).map((text) => `"${text}"`).join(", "),
        },
      ];
};

const DEV_ITEMS = [/^Toggle Developer Tools$/, /^Force Reload$/];

/** A shipped build does not hand users the Chromium developer tools. */
const noDevMenu = (observation: Observation): Violation[] => {
  const found = observation.menus.filter((entry) => DEV_ITEMS.some((pattern) => pattern.test(entry.label)));
  return found.length === 0
    ? []
    : [
        {
          invariant: "no-dev-menu",
          signature: "packaged menu exposes developer items",
          detail: found.map((entry) => `${entry.menu} > ${entry.label}`).join(", "),
        },
      ];
};

// --- the sequence -------------------------------------------------------------

interface Step {
  readonly surface: string;
  readonly action: string;
  readonly started: number;
  readonly violations: Violation[];
}

const runSequence = async (driver: CuaDriver, appPath: string, attempt: number): Promise<AttemptRecord[]> => {
  const records: AttemptRecord[] = [];
  const context = { theme: "system", scale: 0, viewport: "packaged" };
  const finish = (step: Step): void => {
    records.push({
      tier: "t1",
      attempt,
      probeId: `${step.surface}/${step.action}`,
      surface: step.surface,
      action: step.action,
      context,
      durationMs: Date.now() - step.started,
      violations: step.violations,
    });
  };
  const guard = async (step: Step, body: () => Promise<void>): Promise<void> => {
    try {
      await body();
    } catch (error) {
      const message = error instanceof Error ? error.message.split("\n")[0]! : String(error);
      step.violations.push({ invariant: "probe-error", signature: message.slice(0, 200), detail: message });
    }
    finish(step);
  };

  // A. First launch into an empty home.
  const emptyRoot = makeRoot("t1-empty");
  let app: PackagedApp | undefined;
  const firstLaunch: Step = { surface: "app:first-launch", action: "launch", started: Date.now(), violations: [] };
  await guard(firstLaunch, async () => {
    const before = await windowIds(driver);
    try {
      app = await PackagedApp.launch(driver, appPath, emptyRoot);
    } catch (error) {
      if (error instanceof LaunchError) {
        firstLaunch.violations.push({ invariant: "surface-appears", signature: `first launch: ${error.message}`, detail: error.message });
        if (error.pid) await driver.call("kill_app", { pid: error.pid }).catch(() => {});
        return;
      }
      throw error;
    }
    const windows = await app.windows();
    const main = windows.find((w) => w.window_id === app!.windowId);
    if (main?.title !== PRODUCT) {
      firstLaunch.violations.push({
        invariant: "product-name",
        signature: "first launch: window title",
        detail: `main window title "${main?.title ?? ""}"`,
      });
    }
    await Bun.sleep(PROMPT_WINDOW_MS);
    const observation = await app.observe();
    firstLaunch.violations.push(...copyLaw("first launch", observation.texts));
    const extra = (await app.windows()).filter((w) => w.window_id !== app!.windowId && w.is_on_screen && w.bounds.height > 60);
    if (extra.length > 0) {
      firstLaunch.violations.push({
        invariant: "first-launch-clean",
        signature: "first launch opened an extra window",
        detail: extra.map((w) => `"${w.title ?? ""}" ${w.bounds.width}x${w.bounds.height}`).join(", "),
      });
    }
    // Two witnesses: the app's own canvas list vs the empty-canvas state on screen.
    const canvases = await listCanvasesAt(app.home);
    const docs = await Promise.all(canvases.map((name) => readWitnessAt(app!.home, name)));
    const nodeCount = docs.reduce((n, w) => n + w.doc.nodes.length, 0);
    const showsEmpty = observation.texts.some((text) => normalizeText(text) === "empty canvas");
    if (canvases.length === 0 || (nodeCount === 0) !== showsEmpty) {
      firstLaunch.violations.push({
        invariant: "empty-state-parity",
        signature: "first launch: empty state disagrees with the document",
        detail: `canvases ${JSON.stringify(canvases)} hold ${nodeCount} nodes; screen ${showsEmpty ? "shows" : "does not show"} EMPTY CANVAS`,
      });
    }
    for (const prompt of await app.promptsSince(before)) {
      firstLaunch.violations.push({
        invariant: "no-os-prompt",
        signature: `first launch: ${prompt.app} prompt names Junto`,
        detail: `${prompt.title}: ${prompt.text}`,
      });
    }
  });

  if (app) {
    const menus: Step = { surface: "app:menus", action: "read", started: Date.now(), violations: [] };
    await guard(menus, async () => {
      const observation = await app!.observe();
      if (observation.menus.length === 0) {
        menus.violations.push({ invariant: "surface-appears", signature: "menu bar has no items", detail: "no app menu items in AX" });
        return;
      }
      menus.violations.push(...productName("menu bar", [...new Set(observation.menus.map((entry) => entry.menu)), ...observation.menus.map((entry) => entry.label)]));
      menus.violations.push(...noDevMenu(observation));
      menus.violations.push(...copyLaw("menu bar", observation.menus.map((entry) => entry.label)));
    });

    const about: Step = { surface: "menu:about", action: "invoke", started: Date.now(), violations: [] };
    await guard(about, async () => {
      const observation = await app!.observe();
      const item = observation.menus.find((entry) => /^About\b/.test(entry.label));
      if (!item) {
        about.violations.push({ invariant: "surface-appears", signature: "no About item", detail: "app menu has no About item" });
        return;
      }
      const before = new Set((await app!.windows()).map((w) => w.window_id));
      await app!.invokeMenu([item.menu, item.label]);
      let panel: { window_id: number; title?: string } | undefined;
      for (let i = 0; i < 20 && !panel; i += 1) {
        await Bun.sleep(250);
        panel = (await app!.windows()).find((w) => !before.has(w.window_id) && w.bounds.height > 60);
      }
      if (!panel) {
        about.violations.push({ invariant: "surface-appears", signature: "About opened no panel", detail: `${item.menu} > ${item.label}` });
        return;
      }
      const panelView = await app!.observe(panel.window_id);
      about.violations.push(...productName("about panel", [panel.title ?? "", ...panelView.texts]));
      about.violations.push(...copyLaw("about panel", panelView.texts));
      await driver.call("hotkey", { pid: app!.pid, window_id: panel.window_id, keys: ["cmd", "w"], delivery_mode: "foreground" });
      await Bun.sleep(500);
      if ((await app!.windows()).some((w) => w.window_id === panel!.window_id && w.is_on_screen)) {
        about.violations.push({ invariant: "dismiss-clears", signature: "About panel ignores cmd-w", detail: "panel still on screen after cmd-w" });
        await app!.pressEscape().catch(() => {});
      }
    });

    const quit: Step = { surface: "menu:quit", action: "invoke", started: Date.now(), violations: [] };
    await guard(quit, async () => {
      const result = await app!.quit();
      if (!result.delivered) {
        quit.violations.push({ invariant: "probe-error", signature: "quit menu not delivered", detail: result.detail });
      } else if (!result.clean) {
        quit.violations.push({ invariant: "quits-cleanly", signature: "empty home: quit did not exit", detail: `${result.detail} after ${result.ms}ms; killed` });
      }
    });
  }

  // B. A seeded home: reload and relaunch must preserve the document.
  const seededRoot = makeRoot("t1-scene");
  seedScene(REPO_ROOT, seededRoot);
  let seeded: PackagedApp | undefined;
  const sceneLaunch: Step = { surface: "app:scene-launch", action: "launch", started: Date.now(), violations: [] };
  let baseline: string | undefined;
  await guard(sceneLaunch, async () => {
    const before = await windowIds(driver);
    seeded = await PackagedApp.launch(driver, appPath, seededRoot);
    await Bun.sleep(3_000);
    const witness = await readWitnessAt(seeded.home, QA_CANVAS);
    baseline = witness.docHash;
    const observation = await seeded.observe();
    const screen = normalizeText(observation.texts.join(" "));
    const missing = [...witness.titles]
      .filter(([, title]) => title.trim() !== "")
      .filter(([id, title]) => {
        const node = witness.doc.nodes.find((n) => n.id === id);
        const candidates = [title];
        if (node?.type === "link") {
          try {
            candidates.push(new URL(title).host);
          } catch {
            // not a URL
          }
        }
        return !candidates.some((candidate) => screen.includes(normalizeText(candidate)));
      })
      .map(([id, title]) => `${id} "${title}"`);
    if (missing.length > 0) {
      sceneLaunch.violations.push({
        invariant: "label-parity",
        signature: `scene launch: digest titles missing on screen (${missing.length})`,
        detail: missing.join(", "),
      });
    }
    sceneLaunch.violations.push(...copyLaw("scene launch", observation.texts));
    for (const prompt of await seeded.promptsSince(before)) {
      sceneLaunch.violations.push({ invariant: "no-os-prompt", signature: `scene launch: ${prompt.app} prompt names Junto`, detail: `${prompt.title}: ${prompt.text}` });
    }
  });

  if (seeded) {
    const reload: Step = { surface: "menu:view-reload", action: "invoke", started: Date.now(), violations: [] };
    await guard(reload, async () => {
      const observation = await seeded!.observe();
      const item = observation.menus.find((entry) => entry.label === "Reload");
      if (!item) return; // a build without Reload has nothing to check here
      await seeded!.invokeMenu([item.menu, item.label]);
      let back = false;
      for (let i = 0; i < 40 && !back; i += 1) {
        await Bun.sleep(500);
        back = (await seeded!.observe()).elements.some((e) => e.label === "Active canvas");
      }
      if (!back) {
        reload.violations.push({ invariant: "surface-appears", signature: "reload never repainted the canvas", detail: "no Active canvas control within 20s" });
        return;
      }
      const after = await readWitnessAt(seeded!.home, QA_CANVAS);
      if (baseline && after.docHash !== baseline) {
        reload.violations.push({ invariant: "doc-unchanged", signature: "reload changed the document", detail: `${baseline.slice(0, 12)} -> ${after.docHash.slice(0, 12)}` });
      }
    });

    const relaunch: Step = { surface: "app:relaunch", action: "quit-relaunch", started: Date.now(), violations: [] };
    await guard(relaunch, async () => {
      const before = await windowIds(driver);
      const result = await seeded!.quit();
      if (!result.delivered) {
        relaunch.violations.push({ invariant: "probe-error", signature: "quit menu not delivered", detail: result.detail });
      } else if (!result.clean) {
        relaunch.violations.push({ invariant: "quits-cleanly", signature: "scene home: quit did not exit", detail: `${result.detail} after ${result.ms}ms; killed` });
      }
      const again = await PackagedApp.launch(driver, appPath, seededRoot);
      seeded = again;
      await Bun.sleep(3_000);
      const after = await readWitnessAt(again.home, QA_CANVAS);
      if (baseline && after.docHash !== baseline) {
        relaunch.violations.push({
          invariant: "relaunch-preserves-doc",
          signature: "relaunch changed the document",
          detail: `${baseline.slice(0, 12)} -> ${after.docHash.slice(0, 12)}`,
        });
      }
      for (const prompt of await again.promptsSince(before)) {
        relaunch.violations.push({ invariant: "no-os-prompt", signature: `relaunch: ${prompt.app} prompt names Junto`, detail: `${prompt.title}: ${prompt.text}` });
      }
    });
    await seeded.quit().catch(() => undefined);
  }

  for (const root of [emptyRoot, seededRoot]) rmSync(root, { recursive: true, force: true });
  return records;
};

const main = async (): Promise<void> => {
  const startedAt = new Date();
  console.log(`qa:t1: run artifacts in ${OUT_DIR}`);
  const target = argValue("--app") ? { path: argValue("--app")!, reason: "--app" } : resolveTargetApp(REPO_ROOT);
  console.log(`qa:t1: ${target.path} ${appVersion(target.path)} (${target.reason})`);

  const driver = await CuaDriver.connect("junto-qa-t1");
  const records: AttemptRecord[] = [];
  try {
    records.push(...(await runSequence(driver, target.path, 1)));
    if (records.some((record) => record.violations.length > 0)) {
      for (const attempt of [2, 3]) {
        console.log(`qa:t1: attempt ${attempt} (flake gate)`);
        records.push(...(await runSequence(driver, target.path, attempt)));
      }
    }
  } finally {
    await driver.close();
  }

  const finishedAt = new Date();
  const now = finishedAt.toISOString();
  const findings = foldFindings(records, now);
  const first = records.filter((record) => record.attempt === 1);
  const head = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout.trim();
  const run: RunSummary = {
    tier: "t1",
    runId: `qa-t1-${startedAt.toISOString()}`,
    startedAt: startedAt.toISOString(),
    finishedAt: now,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    commit: `${head} (app ${appVersion(target.path)} at ${target.path})`,
    plan: { probes: first.length, fullCrossProduct: first.length, pairsCovered: 0 },
    probeExecutions: records.length,
    probesClean: first.filter((record) => record.violations.length === 0).length,
    findings: {
      total: findings.length,
      confirmed: findings.filter((f) => f.status === "confirmed").length,
      flaky: findings.filter((f) => f.status === "flaky").length,
      new: 0,
    },
    harnessFailures: [],
  };
  const newCount = writeRun(LEDGER_PATH, run, findings, now);
  await Bun.write(join(OUT_DIR, "records.json"), `${JSON.stringify(records, null, 2)}\n`);
  console.log(`\nqa:t1: ${(run.durationMs / 1000).toFixed(0)}s, ${run.probesClean}/${first.length} probes clean on attempt 1`);
  console.log(`qa:t1: ${run.findings.confirmed} confirmed, ${run.findings.flaky} flaky, ${newCount} new -> ${LEDGER_PATH}`);
  for (const finding of findings) {
    console.log(`  ${finding.status} ${finding.fingerprint} ${finding.invariant} ${finding.surface}: ${finding.signature}`);
  }
};

await main();
