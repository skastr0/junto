#!/usr/bin/env bun
/**
 * `bun run qa:t1` — scripted Cua Driver checks of the packaged Junto.app, for
 * the surfaces only a packaged build has: first launch into an empty home,
 * the native menu bar, the About panel, macOS permission prompts Junto itself
 * causes, reload, quit + relaunch, and the first start of a Claude Code and a
 * Hermes seat added through the deck with the default folder in a fresh home
 * (the harness's own screen within 45s, never "resuming", never stuck, and the
 * ended card's reason when a seat dies). After each attempt it reads the
 * unified log for TCC requests attributed to com.skastr0.junto at the pids it
 * launched; every non-preflight request is a finding. No model is called.
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
  findByLabel,
  LaunchError,
  linkHarnessBinaries,
  makeRoot,
  PackagedApp,
  resolveTargetApp,
  seedScene,
  terminalRows,
  windowIds,
  type AxElement,
  type Observation,
} from "../e2e/qa/packaged";
import { QA_CANVAS } from "../e2e/qa/registry";
import { readTccRequests, tccAsker } from "../e2e/qa/tcc";

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

// --- seat start ----------------------------------------------------------------

interface SeatHarness {
  /** Template id, as the canvas document records it. */
  readonly harness: string;
  /** The deck row and the card title. */
  readonly name: string;
  readonly binary: string;
  /** Text only the harness draws once it is up: its composer, a menu, or a first-run screen. */
  readonly prompt: RegExp;
}

const SEAT_HARNESSES: ReadonlyArray<SeatHarness> = [
  {
    harness: "claude",
    name: "Claude Code",
    binary: "claude",
    prompt: /^\s*[❯>](?:\s|$)|\? for shortcuts|enter to (?:select|confirm)|esc to cancel|arrow keys to navigate|do you trust|login method|text style/im,
  },
  {
    harness: "hermes",
    name: "Hermes",
    binary: "hermes",
    prompt: /^\s*❯(?:\s|$)|\bready\b|enter to (?:select|confirm)|↑\/↓ to select/im,
  },
];
const SEAT_PROMPT_MS = 45_000;
const LOAD_LABEL = /^(?:finding session|starting new session|resuming\b.*|attaching|stuck — still loading)$/;
const DEAD_HEADLINE = /^(?:Agent|Process) stopped$/;
const DEAD_BOILERPLATE = new Set(["ended", "The last output stays frozen below.", "If it still held a task, unassign it from the task board."]);

const checked = (element: AxElement): boolean => element.value === true || element.value === 1 || element.value === "1";

/**
 * Settings > Terminal > Screen reader mode, so xterm's rows reach the AX tree
 * and the probe can read what the harness drew. A preference, not state the
 * seat start depends on.
 */
const enableScreenReader = async (app: PackagedApp): Promise<boolean> => {
  const open = await app.waitFor((o) => findByLabel(o, "AXButton", "Open settings"), 10_000);
  if (!open) return false;
  await app.press(open);
  const section = await app.waitFor((o) => findByLabel(o, "AXButton", /^Terminal\b/), 10_000);
  if (!section) return false;
  await app.press(section);
  const toggle = await app.waitFor((o) => findByLabel(o, "AXCheckBox", "Screen reader mode"), 10_000);
  if (!toggle) return false;
  if (!checked(toggle)) await app.press(toggle);
  const on = await app.waitFor((o) => {
    const now = findByLabel(o, "AXCheckBox", "Screen reader mode");
    return now && checked(now) ? now : undefined;
  }, 5_000);
  const close = findByLabel(await app.observe(), "AXButton", "Close settings");
  if (close) await app.press(close);
  else await app.pressEscape();
  return on !== undefined;
};

interface SeatNode {
  readonly id: string;
  readonly cwd?: string;
}

/** Agent seats of one harness in every canvas, as the app's own control socket reports them. */
const agentSeats = async (home: string, harness: string): Promise<SeatNode[]> => {
  const seats: SeatNode[] = [];
  for (const name of await listCanvasesAt(home)) {
    const { doc } = await readWitnessAt(home, name);
    for (const node of doc.nodes) {
      const terminal = node.ether?.terminal as { harness?: string; launch?: { cwd?: string } } | undefined;
      if (node.ether?.entity?.kind === "agent" && terminal?.harness === harness) {
        seats.push({ id: node.id, cwd: terminal.launch?.cwd });
      }
    }
  }
  return seats;
};

const waitForNewSeat = async (home: string, harness: string, before: ReadonlyArray<SeatNode>, timeoutMs: number): Promise<SeatNode | undefined> => {
  const known = new Set(before.map((seat) => seat.id));
  const deadline = Date.now() + timeoutMs;
  do {
    const fresh = (await agentSeats(home, harness)).find((seat) => !known.has(seat.id));
    if (fresh) return fresh;
    await Bun.sleep(500);
  } while (Date.now() < deadline);
  return undefined;
};

/** The ended card's own lines between its headline and its buttons, boilerplate dropped. */
const deadReason = (texts: ReadonlyArray<string>, headline: number): string => {
  const lines: string[] = [];
  for (const text of texts.slice(headline + 1)) {
    const line = text.trim();
    if (line === "Reopen" || line === "Close view" || line === "Opening…") break;
    if (line !== "" && !DEAD_BOILERPLATE.has(line)) lines.push(line);
  }
  return lines.join(" | ") || "(no reason shown)";
};

/**
 * Add one agent through the deck the way a new user does (choose the agent,
 * accept the folder the picker offers, choose it again), open its card, and
 * watch the first start: the load label, the ended card, and the harness's
 * own screen in the terminal rows.
 */
const addAndOpenSeat = async (
  app: PackagedApp,
  seat: SeatHarness,
  rowsReadable: boolean,
): Promise<{ readonly violations: Violation[]; readonly evidence: string }> => {
  const violations: Violation[] = [];
  const notes: string[] = [];
  const flag = (invariant: string, signature: string, detail: string): void => {
    violations.push({ invariant, signature: `${seat.name}: ${signature}`, detail });
  };
  const done = () => ({ violations, evidence: notes.join("; ") });

  const add = await app.waitFor((o) => findByLabel(o, "AXButton", "Add canvas item"), 10_000);
  if (!add) {
    flag("surface-appears", "no Add canvas item control", "no AXButton \"Add canvas item\" in the main window");
    return done();
  }
  await app.press(add);
  const rowOf = (o: Observation) => findByLabel(o, "AXButton", seat.name);
  const row = await app.waitFor(rowOf, 10_000);
  if (!row) {
    flag("surface-appears", "not offered in the add item deck", `${seat.binary} is linked into ~/.local/bin but the deck has no "${seat.name}" row`);
    return done();
  }
  const before = await agentSeats(app.home, seat.harness);
  await app.press(row);
  // With no folder chosen the deck answers with the folder picker, which seeds
  // itself with the home folder: that seed is the default folder.
  let created = await waitForNewSeat(app.home, seat.harness, before, 2_000);
  if (!created) {
    const listing = await app.waitFor((o) => findByLabel(o, "AXList", /^Folders in /), 10_000);
    if (!listing) {
      flag("surface-appears", "choosing the agent opened neither a seat nor the folder picker", "no \"Folders in\" listing within 10s");
      return done();
    }
    notes.push(`default folder ${listing.label!.slice("Folders in ".length)}`);
    const again = await app.waitFor(rowOf, 5_000);
    if (again) {
      await app.press(again);
      created = await waitForNewSeat(app.home, seat.harness, before, 10_000);
    }
  }
  if (!created) {
    flag("seat-created", "choosing the agent with the default folder created no seat", notes.join("; ") || "no picker seen");
    return done();
  }
  notes.push(`seat ${created.id} cwd ${created.cwd ?? "(none)"}`);

  // Open the card. The deck closes on create; skip the top bar and the RTS bar.
  const main = (await app.windows()).find((w) => w.window_id === app.windowId);
  const card = await app.waitFor((o) => {
    if (findByLabel(o, "AXButton", "Close add canvas item")) return undefined;
    return o.elements.find((e) => {
      const text = [e.label, typeof e.value === "string" ? e.value : undefined].find((t) => t?.startsWith(seat.name));
      if (!text || !e.frame || !main) return false;
      return e.frame.y > main.bounds.y + 80 && e.frame.y < main.bounds.y + main.bounds.height - 140;
    });
  }, 10_000);
  if (!card) {
    flag("surface-appears", "new seat has no card on the canvas", `seat ${created.id}`);
    return done();
  }
  await app.pointerClick(card, 2);

  const phases: string[] = [];
  let reached: string | undefined;
  let ended: string | undefined;
  let spinning = false;
  let lastRows: string[] = [];
  const opened = Date.now();
  while (Date.now() - opened < SEAT_PROMPT_MS) {
    const observation = await app.observe();
    const spinner = observation.elements.find((e) => e.label !== undefined && LOAD_LABEL.test(e.label));
    spinning = spinner !== undefined;
    if (spinner && phases.at(-1) !== spinner.label) phases.push(spinner.label!);
    const headline = observation.texts.findIndex((text) => DEAD_HEADLINE.test(text.trim()));
    if (headline >= 0) {
      ended = deadReason(observation.texts, headline);
      break;
    }
    const rows = terminalRows(observation);
    if (rows.length > 0) lastRows = rows;
    const match = spinning ? null : seat.prompt.exec(rows.join("\n"));
    if (match) {
      reached = match[0].trim();
      break;
    }
    await Bun.sleep(150);
  }
  const ms = Date.now() - opened;
  const trail = `phases ${phases.join(" > ") || "(none seen)"}`;
  const screen = lastRows.length > 0 ? `last rows: ${lastRows.slice(-6).map((r) => `"${r}"`).join(" ")}` : "no terminal rows";
  notes.push(trail);

  if (phases.some((phase) => phase.startsWith("resuming"))) {
    flag("first-start-fresh", "first start shows resuming", trail);
  }
  if (phases.some((phase) => phase.startsWith("stuck"))) {
    flag("no-stuck-spinner", "load spinner went stuck", `${trail}; ${ms}ms`);
  }
  if (ended !== undefined) {
    notes.push(`ended after ${ms}ms: ${ended}`);
    flag("seat-starts", `seat ended on first start: ${ended.slice(0, 160)}`, `${ended}; ${trail}; ${screen}`);
  } else if (reached !== undefined) {
    notes.push(`prompt "${reached}" after ${ms}ms`);
  } else if (rowsReadable) {
    flag("reaches-prompt", `no harness prompt within ${SEAT_PROMPT_MS / 1000}s`, `${trail}; ${spinning ? "spinner still up" : "no spinner"}; ${screen}`);
  } else {
    notes.push(`prompt not observable (screen reader mode off); ${spinning ? "spinner still up" : "no spinner"} after ${ms}ms`);
  }
  notes.push(screen);

  const close = findByLabel(await app.observe(), "AXButton", "Close view");
  if (close) await app.press(close);
  else await app.pressEscape();
  await Bun.sleep(500);
  return done();
};

// --- the sequence -------------------------------------------------------------

interface Step {
  readonly surface: string;
  readonly action: string;
  readonly started: number;
  readonly violations: Violation[];
  evidence?: string;
}

/** `pids` collects every app process this attempt launched, for the TCC read. */
const runSequence = async (driver: CuaDriver, appPath: string, attempt: number, pids: Set<number>): Promise<AttemptRecord[]> => {
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
      ...(step.evidence ? { evidence: step.evidence } : {}),
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
      pids.add(app.pid);
    } catch (error) {
      if (error instanceof LaunchError) {
        if (error.pid) pids.add(error.pid);
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
    pids.add(seeded.pid);
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
      pids.add(again.pid);
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

  // C. A fresh home with the harness CLIs installed: add a Claude Code and a
  // Hermes seat through the deck with the default folder, open each, and
  // watch the first start.
  const seatRoot = makeRoot("t1-seats");
  const missing = linkHarnessBinaries(seatRoot, SEAT_HARNESSES.map((seat) => seat.binary));
  let seatApp: PackagedApp | undefined;
  let rowsReadable = false;
  const seatSetup: Step = { surface: "seat:setup", action: "prepare", started: Date.now(), violations: [] };
  await guard(seatSetup, async () => {
    seatApp = await PackagedApp.launch(driver, appPath, seatRoot);
    pids.add(seatApp.pid);
    // The first-run introduction, when this build has one.
    const skip = await seatApp.waitFor((o) => findByLabel(o, "AXButton", /^skip$/i), 5_000);
    if (skip) await seatApp.press(skip);
    rowsReadable = await enableScreenReader(seatApp);
    if (!rowsReadable) {
      seatSetup.violations.push({
        invariant: "probe-error",
        signature: "terminal screen reader mode not reachable",
        detail: "Open settings > Terminal > Screen reader mode did not turn on; terminal rows are unreadable",
      });
    }
  });
  for (const seat of SEAT_HARNESSES) {
    const step: Step = { surface: `seat:${seat.harness}`, action: "add-open", started: Date.now(), violations: [] };
    await guard(step, async () => {
      if (!seatApp) throw new Error("the seat home did not launch");
      if (missing.includes(seat.binary)) {
        step.violations.push({ invariant: "probe-error", signature: `${seat.binary} is not installed on this machine`, detail: `command -v ${seat.binary} found nothing` });
        return;
      }
      const result = await addAndOpenSeat(seatApp, seat, rowsReadable);
      step.violations.push(...result.violations);
      step.evidence = result.evidence;
    });
  }
  if (seatApp) await seatApp.quit().catch(() => undefined);

  for (const root of [emptyRoot, seededRoot, seatRoot]) rmSync(root, { recursive: true, force: true });
  return records;
};

/**
 * One record for the TCC requests this attempt's app processes caused. A
 * preflight only reads the current answer and cannot prompt, so it is
 * evidence; any other request can put a prompt in front of the user and is a
 * violation. The full capture lands in the run directory.
 */
const tccRecord = async (attempt: number, since: Date, until: Date, pids: ReadonlySet<number>): Promise<AttemptRecord> => {
  // tccd's lines reach the log store a moment after the fact.
  await Bun.sleep(2_000);
  const capture = readTccRequests(since, until, pids);
  await Bun.write(join(OUT_DIR, `tcc-attempt-${attempt}.json`), `${JSON.stringify({ pids: [...pids], ...capture }, null, 2)}\n`);
  const violations: Violation[] = capture.error
    ? [{ invariant: "probe-error", signature: "unified log unreadable", detail: capture.error }]
    : capture.requests
        .filter((request) => request.preflight === false)
        .map((request) => ({
          invariant: "no-tcc-request",
          signature: `${request.service ?? "unknown service"} requested for ${tccAsker(request)}`,
          detail: `${request.at} msgID ${request.msgId} authValue ${request.authValue ?? "?"} authReason ${request.authReason ?? "?"}; ${request.processes.map((p) => `${p.role} ${p.identifier} (${p.pid})`).join(", ")}`,
        }));
  const preflights = capture.requests.filter((request) => request.preflight !== false);
  const services = [...new Set(preflights.map((request) => `${request.service ?? "?"} for ${tccAsker(request)}`))];
  return {
    tier: "t1",
    attempt,
    probeId: "os:tcc/watch",
    surface: "os:tcc",
    action: "watch",
    context: { theme: "system", scale: 0, viewport: "packaged" },
    durationMs: until.getTime() - since.getTime(),
    violations,
    evidence: `${capture.requests.length} Junto-attributed requests from pids ${[...pids].join(",")} (${preflights.length} preflight: ${services.join(", ") || "none"}); ${capture.otherJunto} from other Junto instances ignored`,
  };
};

const runAttempt = async (driver: CuaDriver, appPath: string, attempt: number): Promise<AttemptRecord[]> => {
  const pids = new Set<number>();
  const since = new Date();
  const records = await runSequence(driver, appPath, attempt, pids);
  records.push(await tccRecord(attempt, since, new Date(), pids));
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
    records.push(...(await runAttempt(driver, target.path, 1)));
    if (records.some((record) => record.violations.length > 0)) {
      for (const attempt of [2, 3]) {
        console.log(`qa:t1: attempt ${attempt} (flake gate)`);
        records.push(...(await runAttempt(driver, target.path, attempt)));
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
  for (const record of first.filter((r) => r.evidence)) {
    console.log(`  ${record.surface}: ${record.evidence}`);
  }
};

await main();
