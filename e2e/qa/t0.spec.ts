/**
 * T0 QA runner: executes one attempt of a pairwise probe plan against the
 * built app under the standard e2e harness. Zero model calls.
 *
 * Driven by `bun run qa:t0` (scripts/qa-t0.ts), which writes the chunk file
 * named by QA_T0_CHUNKS and folds the records this spec writes into
 * test-results/qa-ledger.json. Findings are recorded, never thrown: a test
 * here fails only when the harness itself cannot run the chunk.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, launchJunto, test, type JuntoHandle } from "../harness/launch";
import type { AttemptRecord } from "./ledger";
import {
  checkCopyLaw,
  checkLabelParity,
  checkRenderParity,
  normalizeText,
  readAppWitness,
  readRenderedNodes,
  type AppWitness,
  type Violation,
} from "./oracle";
import type { Probe } from "./pairwise";
import { QA_CANVAS, SURFACES, VIEWPORTS, invariantsFor, qaScene, type Surface } from "./registry";

export interface Chunk {
  readonly id: string;
  readonly scale: number;
  readonly probes: ReadonlyArray<Probe>;
}

export interface ChunkFile {
  readonly attempt: number;
  readonly outDir: string;
  readonly chunks: ReadonlyArray<Chunk>;
}

const chunkPath = process.env.QA_T0_CHUNKS;
const plan: ChunkFile | undefined = chunkPath
  ? (JSON.parse(readFileSync(chunkPath, "utf8")) as ChunkFile)
  : undefined;

const surfaceById = new Map(SURFACES.map((surface) => [surface.id, surface] as const));
const SURFACE_TIMEOUT_MS = 5_000;
const OVERLAY = '[role="dialog"]:visible, [role="alertdialog"]:visible, .settings-panel:visible';

// --- gestures ------------------------------------------------------------------

const fitAll = async (page: Page): Promise<void> => {
  const fit = page.getByRole("button", { name: /fit all/i });
  if (await fit.isVisible().catch(() => false)) await fit.click();
  await page.waitForTimeout(250);
};

/** A point on the rendered wire itself, in page coordinates. */
const edgePoint = async (page: Page, edgeId: string): Promise<{ x: number; y: number }> => {
  const path = page.getByTestId(`rf__edge-${edgeId}`).locator("path").first();
  const point = await path.evaluate((el) => {
    const svgPath = el as SVGPathElement;
    const at = svgPath.getPointAtLength(svgPath.getTotalLength() / 2);
    const matrix = svgPath.getScreenCTM();
    if (!matrix) return null;
    return { x: at.x * matrix.a + at.y * matrix.c + matrix.e, y: at.x * matrix.b + at.y * matrix.d + matrix.f };
  });
  if (!point) throw new Error(`edge ${edgeId} has no screen transform`);
  return point;
};

const inViewport = async (page: Page, locator: Locator, scope: string): Promise<Violation[]> => {
  const box = await locator.boundingBox();
  const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  if (!box) return [{ invariant: "in-viewport", signature: `${scope}: no box`, detail: "surface has no bounding box" }];
  const over = {
    left: Math.max(0, -box.x),
    top: Math.max(0, -box.y),
    right: Math.max(0, box.x + box.width - size.width),
    bottom: Math.max(0, box.y + box.height - size.height),
  };
  const sides = Object.entries(over).filter(([, px]) => px > 1);
  if (sides.length === 0) return [];
  return [
    {
      invariant: "in-viewport",
      signature: `${scope}: overflows ${sides.map(([side]) => side).join("+")}`,
      detail: `box ${JSON.stringify(box)} in window ${size.width}x${size.height}; overflow ${JSON.stringify(over)}`,
    },
  ];
};

const dismiss = async (page: Page, surface: Surface): Promise<void> => {
  if (surface.dismiss === "close-button") {
    const settingsClose = page.locator(".settings-panel__close");
    if (await settingsClose.isVisible().catch(() => false)) await settingsClose.click().catch(() => {});
    const close = page.getByRole("button", { name: /^close$/i }).first();
    if (await close.isVisible().catch(() => false)) await close.click().catch(() => {});
  }
  for (let i = 0; i < 3; i += 1) await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
};

/** Hard reset between probes so one stuck overlay cannot poison the next probe. */
const reset = async (page: Page): Promise<void> => {
  const settingsClose = page.locator(".settings-panel__close");
  if (await settingsClose.isVisible().catch(() => false)) await settingsClose.click().catch(() => {});
  const close = page.getByRole("button", { name: /^close$/i }).first();
  if (await close.isVisible().catch(() => false)) await close.click().catch(() => {});
  for (let i = 0; i < 3; i += 1) await page.keyboard.press("Escape");
};

const applyContext = async (junto: JuntoHandle, probe: Probe): Promise<void> => {
  const { app, page } = junto;
  await page.emulateMedia({ colorScheme: probe.theme === "bright" ? "light" : "dark" });
  const size = VIEWPORTS[probe.viewport];
  await app.evaluate(({ BrowserWindow }, next) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    win?.setContentSize(next.width, next.height);
  }, size);
  await page.waitForTimeout(300);
  const expected = probe.theme === "bright" ? "bright" : null;
  const actual = await page.evaluate(() => document.documentElement.dataset.theme ?? null);
  if (actual !== expected) {
    throw new Error(`system theme did not follow the OS colour scheme: wanted ${expected ?? "dark"}, got ${actual ?? "dark"}`);
  }
  await fitAll(page);
};

// --- probes --------------------------------------------------------------------

const selectionChecks = async (
  page: Page,
  surface: Surface,
  witness: AppWitness,
  wanted: Set<string>,
): Promise<Violation[]> => {
  const out: Violation[] = [];
  const label = page.locator(".rts-kind-surface .rts-kind-kind-label").first();
  const appeared = await label.waitFor({ state: "visible", timeout: SURFACE_TIMEOUT_MS }).then(
    () => true,
    () => false,
  );
  if (!appeared) {
    out.push({ invariant: "surface-appears", signature: `${surface.id}: rts kind surface`, detail: "the RTS kind surface never appeared" });
    return out;
  }
  if (!wanted.has("selection-parity")) return out;
  const shown = normalizeText((await label.textContent()) ?? "");
  let expected: string | undefined;
  if (surface.kind === "edge") {
    expected = witness.doc.edges.find((edge) => edge.id === surface.target)?.ether?.verb;
  } else {
    expected = witness.doc.nodes.find((node) => node.id === surface.target)?.ether?.entity?.kind;
  }
  if (expected !== undefined && shown !== normalizeText(expected)) {
    out.push({
      invariant: "selection-parity",
      signature: `${surface.id}: rts label disagrees with document`,
      detail: `RTS shows "${shown}", document holds "${expected}"`,
    });
  }
  if (surface.kind === "node" && surface.target) {
    const title = witness.titles.get(surface.target);
    const bar = normalizeText((await page.locator(".rts-shell").first().textContent().catch(() => "")) ?? "");
    if (title && !bar.includes(normalizeText(title))) {
      out.push({
        invariant: "selection-parity",
        signature: `${surface.id}: rts bar lacks digest title`,
        detail: `digest title "${title}" not in the RTS bar`,
      });
    }
  }
  return out;
};

const runAction = async (
  junto: JuntoHandle,
  surface: Surface,
  probe: Probe,
  witness: AppWitness,
  wanted: Set<string>,
): Promise<Violation[]> => {
  const { page } = junto;
  const out: Violation[] = [];
  if (surface.kind === "edge") {
    const point = await edgePoint(page, surface.target!);
    if (probe.action === "open") await page.mouse.dblclick(point.x, point.y);
    else await page.mouse.click(point.x, point.y);
    out.push(...(await selectionChecks(page, surface, witness, wanted)));
    out.push(...(await checkCopyLaw(page, surface.id)));
    return out;
  }
  if (surface.kind === "node") {
    const node = page.locator(`.react-flow__node[data-id="${surface.target}"]`);
    await node.waitFor({ state: "visible", timeout: SURFACE_TIMEOUT_MS });
    if (probe.action === "select") {
      await node.click({ position: { x: 10, y: 10 } });
      out.push(...(await selectionChecks(page, surface, witness, wanted)));
    } else {
      await node.dblclick({ position: { x: 10, y: 10 } });
      const overlay = page.locator(OVERLAY).first();
      const appeared = await overlay.waitFor({ state: "visible", timeout: SURFACE_TIMEOUT_MS }).then(
        () => true,
        () => false,
      );
      if (!appeared) {
        out.push({ invariant: "surface-appears", signature: `${surface.id}: detail surface`, detail: "double click opened no dialog" });
      } else {
        await page.waitForTimeout(300);
        out.push(...(await inViewport(page, overlay, surface.id)));
      }
    }
    out.push(...(await checkCopyLaw(page, surface.id)));
    return out;
  }
  if (probe.action === "palette-tabs") {
    const add = page.getByRole("button", { name: "Add canvas item" }).first();
    await add.click();
    const tabs = page.getByRole("tab");
    const appeared = await tabs.first().waitFor({ state: "visible", timeout: SURFACE_TIMEOUT_MS }).then(
      () => true,
      () => false,
    );
    if (!appeared) {
      out.push({ invariant: "surface-appears", signature: "palette: tabs", detail: "the add-item deck showed no tabs" });
      return out;
    }
    const count = await tabs.count();
    for (let i = 0; i < count; i += 1) {
      const tab = tabs.nth(i);
      const name = normalizeText((await tab.textContent()) ?? `tab ${i}`);
      await tab.click();
      await page.waitForTimeout(200);
      out.push(...(await checkCopyLaw(page, `palette ${name}`)));
      out.push(...(await inViewport(page, page.getByRole("tablist").first(), `palette ${name}`)));
    }
    return out;
  }
  // settings-sections
  await page.getByRole("button", { name: "Open settings" }).click();
  const panel = page.locator(".settings-panel");
  const appeared = await panel.waitFor({ state: "visible", timeout: SURFACE_TIMEOUT_MS }).then(
    () => true,
    () => false,
  );
  if (!appeared) {
    out.push({ invariant: "surface-appears", signature: "settings: panel", detail: "settings panel never appeared" });
    return out;
  }
  out.push(...(await inViewport(page, panel, "settings")));
  const items = page.locator(".settings-nav__item");
  const count = await items.count();
  for (let i = 0; i < count; i += 1) {
    const item = items.nth(i);
    const name = normalizeText((await item.textContent()) ?? `section ${i}`);
    await item.click();
    await page.waitForTimeout(200);
    out.push(...(await checkCopyLaw(page, `settings ${name}`)));
  }
  return out;
};

const runProbe = async (
  junto: JuntoHandle,
  probe: Probe,
  errors: string[],
  evidenceDir: string,
  attempt: number,
): Promise<AttemptRecord> => {
  const { page, sandbox } = junto;
  const started = Date.now();
  const surface = surfaceById.get(probe.surface);
  const violations: Violation[] = [];
  let evidence: string | undefined;
  try {
    if (!surface) throw new Error(`unknown surface ${probe.surface}`);
    const wanted = new Set<string>(invariantsFor(surface, probe.action));
    await reset(page);
    await applyContext(junto, probe);
    errors.length = 0;
    const before = await readAppWitness(sandbox, QA_CANVAS);
    violations.push(...(await runAction(junto, surface, probe, before, wanted)));
    if (violations.length > 0) {
      evidence = join(evidenceDir, `${probe.id.replace(/[^\w.-]+/g, "_")}.png`);
      await page.screenshot({ path: evidence }).catch(() => {
        evidence = undefined;
      });
    }
    await dismiss(page, surface);
    const stuck = page.locator(OVERLAY);
    if (surface.kind !== "edge" && (await stuck.count()) > 0) {
      const name = (await stuck.first().getAttribute("aria-label").catch(() => null)) ?? (await stuck.first().getAttribute("class").catch(() => null)) ?? "overlay";
      violations.push({
        invariant: "dismiss-clears",
        signature: `${surface.id}: ${surface.dismiss} left an overlay open`,
        detail: `after ${surface.dismiss}, "${name}" is still visible`,
      });
    }
    const after = await readAppWitness(sandbox, QA_CANVAS);
    if (after.docHash !== before.docHash) {
      violations.push({
        invariant: "doc-unchanged",
        signature: `${surface.id}/${probe.action} mutated the document`,
        detail: `doc sha256 ${before.docHash.slice(0, 12)} -> ${after.docHash.slice(0, 12)}`,
      });
    }
    for (const error of new Set(errors)) {
      violations.push({ invariant: "no-page-errors", signature: error.slice(0, 200), detail: error.slice(0, 2_000) });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0]! : String(error);
    violations.push({ invariant: "probe-error", signature: message.slice(0, 200), detail: message });
    await reset(page).catch(() => {});
  }
  return {
    attempt,
    probeId: probe.id,
    surface: probe.surface,
    action: probe.action,
    context: { theme: probe.theme, scale: probe.scale, viewport: probe.viewport },
    durationMs: Date.now() - started,
    violations,
    ...(evidence ? { evidence } : {}),
  };
};

/** Board-level two-witness check once the scene settles. */
const settleRecord = async (junto: JuntoHandle, chunk: Chunk, attempt: number): Promise<AttemptRecord> => {
  const started = Date.now();
  const violations: Violation[] = [];
  try {
    const witness = await readAppWitness(junto.sandbox, QA_CANVAS);
    const rendered = await readRenderedNodes(junto.page);
    violations.push(...checkRenderParity(witness, rendered));
    violations.push(...checkLabelParity(witness, rendered));
    violations.push(...(await checkCopyLaw(junto.page, "board")));
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0]! : String(error);
    violations.push({ invariant: "probe-error", signature: message.slice(0, 200), detail: message });
  }
  return {
    attempt,
    probeId: `board/settle/dark/${chunk.scale}/wide`,
    surface: "board",
    action: "settle",
    context: { theme: "dark", scale: chunk.scale, viewport: "wide" },
    durationMs: Date.now() - started,
    violations,
  };
};

if (plan) {
  const evidenceDir = join(plan.outDir, `attempt-${plan.attempt}`, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  for (const chunk of plan.chunks) {
    test(`qa t0 attempt ${plan.attempt} ${chunk.id}`, async () => {
      test.setTimeout(120_000 + chunk.probes.length * 30_000);
      const junto = await launchJunto({
        seedCanvases: { [QA_CANVAS]: qaScene() },
        ...(chunk.scale !== 1 ? { electronArgs: [`--force-device-scale-factor=${chunk.scale}`] } : {}),
      });
      const errors: string[] = [];
      junto.page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
      junto.page.on("console", (message) => {
        if (message.type() === "error") errors.push(`console: ${message.text()}`);
      });
      const records: AttemptRecord[] = [];
      try {
        await expect(junto.page.locator('.react-flow__node[data-id="tasks"]')).toBeVisible({ timeout: 30_000 });
        await junto.page.emulateMedia({ colorScheme: "dark" });
        await fitAll(junto.page);
        records.push(await settleRecord(junto, chunk, plan.attempt));
        for (const probe of chunk.probes) {
          records.push(await runProbe(junto, probe, errors, evidenceDir, plan.attempt));
        }
      } finally {
        const outFile = join(plan.outDir, `attempt-${plan.attempt}`, `${chunk.id}.json`);
        await mkdir(join(plan.outDir, `attempt-${plan.attempt}`), { recursive: true });
        await writeFile(outFile, `${JSON.stringify(records, null, 2)}\n`, "utf8");
        await junto.close();
      }
    });
  }
} else {
  test("qa t0 needs a chunk file", () => {
    test.skip(true, "run through `bun run qa:t0`, which writes QA_T0_CHUNKS");
  });
}
