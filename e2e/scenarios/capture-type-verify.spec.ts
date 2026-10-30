/**
 * Real app, the quick capture type pass (52a5dcab4), at 1500x900, dark and
 * bright. Every line that draws text in the surface, in each state (the ask,
 * the editor with three lines, the list with rows, a row's preview, search),
 * is read for its computed font size. Only 10, 11, 12 and 14px pass; 16px
 * (the browser default) or any other size is reported with its selector.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/capture-type-verify.spec.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { asNodeId } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelNode } from "../harness/model";

const CANVAS = "capture-type";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/capture-type-verify";
const ALLOWED = new Set(["10px", "11px", "12px", "14px"]);

type Line = { size: string; where: string; text: string };

const surface = (page: Page): Locator => page.getByRole("dialog", { name: "Quick capture" });
const entry = (page: Page): Locator => page.locator("[data-capture-entry] .cm-content").first();

// Every element in the dialog that draws text of its own (a text node child, a
// field's value or placeholder), with its computed size and a short path.
const measure = (page: Page): Promise<ReadonlyArray<Line>> =>
  surface(page).evaluate((root) => {
    const path = (el: Element): string => {
      const parts: string[] = [];
      for (let e: Element | null = el; e && e !== root.parentElement && parts.length < 3; e = e.parentElement) {
        const cls = [...e.classList].filter((c) => !c.startsWith("cm-line") || true).slice(0, 2).join(".");
        parts.unshift(`${e.tagName.toLowerCase()}${cls ? `.${cls}` : ""}`);
      }
      return parts.join(" > ");
    };
    const out: { size: string; where: string; text: string }[] = [];
    for (const el of root.querySelectorAll("*")) {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      let text = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? "").join("").trim();
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) text = el.value || el.placeholder ? `[field] ${el.value || el.placeholder}` : "";
      if (!text) continue;
      out.push({ size: style.fontSize, where: path(el), text: text.slice(0, 48) });
    }
    return out;
  });

test("quick capture type pass: only 10, 11, 12 and 14px, nothing at 16px", async () => {
  test.setTimeout(300_000);
  const junto = await launchJunto({
    windowContentSize: { width: 1500, height: 900 },
    seedModels: {
      [CANVAS]: modelFixture([modelNode({ kind: "artifacts", id: "notes", label: "Research notes", x: 60, y: 60, width: 300, height: 160, z: 0 })]),
    },
  });
  const states: Record<string, ReadonlyArray<Line>> = {};
  try {
    const { page } = junto;
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await expect(page.locator('.react-flow__node[data-id="notes"]')).toBeVisible({ timeout: 30_000 });
    for (const [title, markdown] of [
      ["Roadmap pricing tiers", "# Roadmap pricing tiers\n\nQuarterly roadmap pricing tiers for the launch review."],
      ["Errands for the week", "# Errands for the week\n\nMilk, eggs, bread and the errands before Friday."],
    ] as const) {
      await page.evaluate(
        ({ canvas, node, artifactId, opId, title, markdown }) =>
          window.junto!.resource!.artifact!.apply(canvas, node, artifactId as never, opId, { op: "create", title, body: { type: "document", markdown }, labels: [] }),
        { canvas: CANVAS, node: asNodeId("notes"), artifactId: mintItemId(), opId: mintOpId(), title, markdown },
      );
    }
    const record = async (name: string): Promise<void> => {
      await page.waitForTimeout(400);
      for (const theme of ["dark", "bright"] as const) {
        mkdirSync(join(SHOTS, theme), { recursive: true });
        await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
        await page.waitForTimeout(300);
        await page.screenshot({ path: join(SHOTS, theme, `${name}.png`) });
        states[`${theme}/${name}`] = await measure(page);
      }
      await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    };

    await page.locator(".react-flow__pane").click({ position: { x: 1200, y: 700 } });
    await page.keyboard.press("Meta+t");
    await expect(surface(page)).toBeVisible({ timeout: 10_000 });
    await record("01-ask");
    await surface(page).getByRole("button", { name: "Make an Inbox", exact: true }).click();
    await expect(entry(page)).toBeFocused({ timeout: 15_000 });
    await page.keyboard.type("Roadmap pricing notes");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Quarterly roadmap pricing tiers for launch.");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Ask about the review.");
    await page.waitForTimeout(2500);
    await record("02-editor");
    await page.keyboard.press("Escape");
    await expect(surface(page)).toBeHidden({ timeout: 5_000 });

    await page.keyboard.press("Meta+t");
    await expect(surface(page)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".quick-capture__row").first()).toBeVisible({ timeout: 10_000 });
    await record("03-list");
    await page.getByLabel("Search every artifact", { exact: true }).fill("pricing");
    await page.waitForTimeout(800);
    await record("04-search-preview");
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(500);
    await record("05-search-next");
  } finally {
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(join(SHOTS, "sizes.json"), JSON.stringify(states, null, 2));
    await junto.close();
  }
  const bad = Object.entries(states).flatMap(([state, lines]) => lines.filter((l) => !ALLOWED.has(l.size)).map((l) => ({ state, ...l })));
  console.log("TYPE-SIZES", JSON.stringify(Object.fromEntries(Object.entries(states).map(([s, ls]) => [s, [...new Set(ls.map((l) => l.size))]]))));
  console.log("TYPE-OFF-SCALE", JSON.stringify(bad));
  expect(Object.keys(states).length).toBeGreaterThan(0);
  expect(bad).toEqual([]);
});
