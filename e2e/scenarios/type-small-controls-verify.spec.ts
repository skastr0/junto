/**
 * Real app, the small Button and key cap step to label (241f30433,
 * 9f5677655) and the quick capture headings (dd99500e2), at 1500x900, dark
 * and bright. Four surfaces: the Cmd+T editor head and footer, the editor and
 * the search preview of a document that starts with headings (H1 14/600, H2
 * and H3 12/600 in both), Settings Keyboard shortcuts, and the RTS bar on a
 * seat and on an edge. Every line that draws text is read for its size and
 * weight; a small Button or key cap is also read for truncation (text wider
 * than its box) and wrap (taller than one line).
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/type-small-controls-verify.spec.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { asNodeId } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelNode, modelSeat, modelWire } from "../harness/model";

const CANVAS = "type-small";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/type-small-controls-verify";
const ALLOWED = new Set(["10px", "11px", "12px", "14px"]);
const DOC = "# Roadmap pricing tiers\n\n## Tiers\n\n### Launch review\n\nQuarterly roadmap pricing tiers for the launch review.";

type Line = { size: string; weight: string; where: string; text: string; small: boolean; truncated: boolean; wrapped: boolean };

const surface = (page: Page): Locator => page.getByRole("dialog", { name: "Quick capture" });
const entry = (page: Page): Locator => page.locator("[data-capture-entry] .cm-content").first();

// Every element under root that draws text of its own, with its size, weight
// and a short path. A Button or key cap (the small controls under test) is
// also read for truncation and wrap.
const measure = (root: Locator): Promise<ReadonlyArray<Line>> =>
  root.evaluate((rootEl) => {
    const path = (el: Element): string => {
      const parts: string[] = [];
      for (let e: Element | null = el; e && e !== rootEl.parentElement && parts.length < 3; e = e.parentElement) {
        const cls = [...e.classList].slice(0, 2).join(".");
        parts.unshift(`${e.tagName.toLowerCase()}${cls ? `.${cls}` : ""}`);
      }
      return parts.join(" > ");
    };
    const out: Line[] = [];
    for (const el of rootEl.querySelectorAll("*")) {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      let text = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? "").join("").trim();
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) text = el.value || el.placeholder ? `[field] ${el.value || el.placeholder}` : "";
      if (!text) continue;
      const control = el.closest("button, kbd");
      const small = control !== null && rootEl.contains(control);
      const box = (control ?? el) as HTMLElement;
      const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.3;
      const range = document.createRange();
      range.selectNodeContents(el);
      const lines = new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
      out.push({
        size: style.fontSize,
        weight: style.fontWeight,
        where: path(el),
        text: text.slice(0, 48),
        small,
        truncated: small && (box.scrollWidth > box.clientWidth + 1 || (el as HTMLElement).scrollWidth > (el as HTMLElement).clientWidth + 1),
        wrapped: small && (lines > 1 || rect.height > lineHeight * 1.6 + 4),
      });
    }
    return out;
  });

test("small Button and key cap at label, quick capture headings: sizes, truncation and wrap on four surfaces", async () => {
  test.setTimeout(400_000);
  const nodes = [
    modelNode({ kind: "artifacts", id: "notes", label: "Research notes", x: 60, y: 60, width: 300, height: 160, z: 0 }),
    modelSeat({ id: "agent1", key: "local:writer", label: "writer", x: 420, y: 60 }),
    modelSeat({ id: "agent2", key: "local:reviewer", label: "reviewer", x: 760, y: 60 }),
  ];
  const junto = await launchJunto({
    windowContentSize: { width: 1500, height: 900 },
    seedModels: { [CANVAS]: modelFixture(nodes, [modelWire("e1", "agent1", "agent2", "messages", nodes)]) },
  });
  const states: Record<string, ReadonlyArray<Line>> = {};
  const misses: string[] = [];
  try {
    const { page } = junto;
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await expect(page.locator('.react-flow__node[data-id="notes"]')).toBeVisible({ timeout: 30_000 });
    await page.evaluate(
      ({ canvas, node, artifactId, opId, markdown }) =>
        window.junto!.resource!.artifact!.apply(canvas, node, artifactId as never, opId, { op: "create", title: "Roadmap pricing tiers", body: { type: "document", markdown }, labels: [] }),
      { canvas: CANVAS, node: asNodeId("notes"), artifactId: mintItemId(), opId: mintOpId(), markdown: DOC },
    );
    const record = async (name: string, root: Locator): Promise<void> => {
      await page.waitForTimeout(400);
      for (const theme of ["dark", "bright"] as const) {
        mkdirSync(join(SHOTS, theme), { recursive: true });
        await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
        await page.waitForTimeout(300);
        await page.screenshot({ path: join(SHOTS, theme, `${name}.png`) });
        states[`${theme}/${name}`] = await measure(root);
      }
      await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    };
    const step = async (name: string, run: () => Promise<void>): Promise<void> => {
      try {
        await run();
      } catch (error) {
        misses.push(`${name}: ${String(error).split("\n")[0]}`);
      }
    };

    // Cmd+T: the editor head (Move to) and footer key caps, then headings in the editor and in the search preview.
    await step("capture", async () => {
      await page.locator(".react-flow__pane").click({ position: { x: 1200, y: 700 } });
      await page.keyboard.press("Meta+t");
      await expect(surface(page)).toBeVisible({ timeout: 10_000 });
      await surface(page).getByRole("button", { name: "Make an Inbox", exact: true }).click();
      await expect(entry(page)).toBeFocused({ timeout: 15_000 });
      await page.keyboard.type("Capture with headings");
      await page.keyboard.press("Enter");
      for (const line of ["# Heading one", "## Heading two", "### Heading three", "Body line under the headings."]) {
        await page.keyboard.press("Enter");
        await page.keyboard.type(line);
      }
      await page.waitForTimeout(2500);
      await record("01-capture-editor-headings", surface(page));
      await page.keyboard.press("Escape");
      await expect(surface(page)).toBeHidden({ timeout: 5_000 });
      await page.keyboard.press("Meta+t");
      await expect(surface(page)).toBeVisible({ timeout: 10_000 });
      await page.getByLabel("Search every artifact", { exact: true }).fill("roadmap");
      await page.waitForTimeout(800);
      await page.keyboard.press("ArrowDown");
      await expect(surface(page).locator(".cm-md-h1").first()).toBeVisible({ timeout: 10_000 });
      await record("02-capture-search-preview", surface(page));
      await page.getByLabel("Search every artifact", { exact: true }).click();
      await page.keyboard.press("Escape");
      if (await surface(page).isVisible()) await page.keyboard.press("Meta+t");
      await expect(surface(page)).toBeHidden({ timeout: 5_000 });
    });

    // Settings, Keyboard shortcuts: sm and xs Buttons and key caps.
    await step("settings", async () => {
      await page.getByRole("button", { name: "Open settings", exact: true }).click();
      await page.locator(".settings-nav__item", { hasText: "Keyboard shortcuts" }).click();
      const settings = page.getByRole("dialog", { name: "Settings" });
      await expect(settings).toBeVisible({ timeout: 10_000 });
      await record("03-settings-keyboard", settings);
      await page.locator(".settings-panel__close").click();
      await expect(settings).toBeHidden({ timeout: 5_000 });
    });

    // The RTS bar on a seat, then on an edge (its relation strip carries xs Buttons).
    await step("rts seat", async () => {
      await page.locator(".react-flow__node", { hasText: "writer" }).first().click();
      await expect(page.locator(".rts-shell")).toBeVisible({ timeout: 10_000 });
      await record("04-rts-seat", page.locator(".rts-shell"));
    });
    await step("rts edge", async () => {
      await page.getByRole("button", { name: /^Select edge -/u }).first().press("Enter");
      await expect(page.locator(".rts-kind-strip")).toBeVisible({ timeout: 10_000 });
      await record("05-rts-edge", page.locator(".rts-shell"));
    });
  } finally {
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(join(SHOTS, "sizes.json"), JSON.stringify({ states, misses }, null, 2));
    await junto.close();
  }
  const off = Object.entries(states).flatMap(([state, lines]) => lines.filter((l) => !ALLOWED.has(l.size)).map((l) => ({ state, ...l })));
  const broken = Object.entries(states).flatMap(([state, lines]) => lines.filter((l) => l.truncated || l.wrapped).map((l) => ({ state, ...l })));
  const headings = Object.fromEntries(
    Object.entries(states).map(([s, ls]) => [s, ls.filter((l) => /cm-md-h[1-3]|preview-title|artifact-head__title/u.test(l.where)).map((l) => `${l.where.split(" > ").pop()} ${l.size}/${l.weight} ${l.text}`)]),
  );
  console.log("SMALL-MISSES", JSON.stringify(misses));
  console.log("SMALL-SIZES", JSON.stringify(Object.fromEntries(Object.entries(states).map(([s, ls]) => [s, [...new Set(ls.map((l) => l.size))]]))));
  console.log("SMALL-HEADINGS", JSON.stringify(headings));
  console.log("SMALL-OFF-SCALE", JSON.stringify(off));
  console.log("SMALL-BROKEN", JSON.stringify(broken));
  expect(misses).toEqual([]);
  expect(off).toEqual([]);
  expect(broken).toEqual([]);
});
