/**
 * Real app, the final Cmd+T walk (00f6b9f3f and on), at 1500x900, dark and
 * bright, five states: (1) no artifacts yet, a new capture with the caret in
 * its body; (2) the list with Inbox and recent rows; (3) a document row
 * previewed by the arrows, then the same row after Enter, its title and first
 * line boxes kept to show nothing moves; (4) the editor with focus in the body
 * (no frame round the pane) and the list with keyboard focus (a ring on the
 * active row only); (5) search with matches and with none. Each frame reads
 * the dialog's size, every line's font size, any one-sided coloured edge, and
 * whether each row title ellipses.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/capture-final-walk.spec.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { asNodeId } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelNode } from "../harness/model";

const CANVAS = "capture-final";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/capture-final-walk";
const LONG = "Quarterly roadmap pricing tiers for the launch review and the partner programme rollout";

const surface = (page: Page): Locator => page.getByRole("dialog", { name: "Quick capture" });
const entry = (page: Page): Locator => page.locator("[data-capture-entry] .cm-content").first();
const search = (page: Page): Locator => page.getByLabel("Search every artifact", { exact: true });

// The dialog's box; every text line's size; any element with one coloured side
// (a border on one side only, or a one-direction inset shadow); each row
// title's ellipsis; the focus rings drawn (outline or ring shadow) and where.
const measure = (root: Locator) =>
  root.evaluate((rootEl) => {
    const chroma = (c: string): boolean => {
      const m = c.match(/oklab\(([\d.]+) (-?[\d.]+) (-?[\d.]+)/u) ?? c.match(/oklch\(([\d.]+) ([\d.]+)/u);
      if (m) return c.startsWith("oklch") ? Number(m[2]) > 0.04 : Math.hypot(Number(m[2]), Number(m[3])) > 0.04;
      const r = c.match(/rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?/u);
      if (!r || r[4] === "0") return false;
      const [a, b, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
      return Math.max(a, b, d) - Math.min(a, b, d) > 24;
    };
    const path = (el: Element): string => {
      const parts: string[] = [];
      for (let e: Element | null = el; e && e !== rootEl.parentElement && parts.length < 3; e = e.parentElement)
        parts.unshift(`${e.tagName.toLowerCase()}${e.classList.length ? `.${[...e.classList].slice(0, 2).join(".")}` : ""}`);
      return parts.join(" > ");
    };
    const box = rootEl.getBoundingClientRect();
    const sizes: { size: string; where: string; text: string }[] = [];
    const oneSided: { where: string; detail: string }[] = [];
    const rings: { where: string; outline: string; shadow: string }[] = [];
    for (const el of rootEl.querySelectorAll("*")) {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (s.display === "none" || s.visibility === "hidden" || r.width === 0 || r.height === 0) continue;
      let text = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? "").join("").trim();
      if (el instanceof HTMLInputElement) text = el.value || el.placeholder ? `[field] ${el.value || el.placeholder}` : "";
      if (text && !el.classList.contains("sr-only")) sizes.push({ size: s.fontSize, where: path(el), text: text.slice(0, 40) });
      const sides = (["Top", "Right", "Bottom", "Left"] as const).filter((k) => Number.parseFloat(s[`border${k}Width`]) > 0 && s[`border${k}Style`] !== "none");
      if (sides.length === 1 && chroma(s[`border${sides[0]!}Color`])) oneSided.push({ where: path(el), detail: `border-${sides[0]!.toLowerCase()} ${s[`border${sides[0]!}Color`]}` });
      for (const shadow of s.boxShadow === "none" ? [] : s.boxShadow.split(/,(?![^(]*\))/u)) {
        if (!shadow.includes("inset")) continue;
        const nums = (shadow.replace(/(rgba?|oklab|oklch|color-mix)\([^)]*\)/gu, "").match(/-?[\d.]+px/gu) ?? []).map((n) => Number.parseFloat(n));
        const [x = 0, y = 0, blur = 0, spread = 0] = nums;
        if ((x !== 0) !== (y !== 0) && blur === 0 && spread === 0) oneSided.push({ where: path(el), detail: `inset shadow ${shadow.trim()}` });
      }
      if ((s.outlineStyle !== "none" && Number.parseFloat(s.outlineWidth) > 0) || /0px 0px 0px [1-9]/u.test(s.boxShadow))
        rings.push({ where: path(el), outline: `${s.outlineWidth} ${s.outlineStyle} ${s.outlineColor}`, shadow: s.boxShadow });
    }
    const titles = [...rootEl.querySelectorAll(".quick-capture__row-title, .artifact-head__title, .quick-capture__preview-title")].map((el) => {
      const s = getComputedStyle(el);
      const h = el as HTMLElement;
      return { where: path(el), text: (h instanceof HTMLInputElement ? h.value : h.textContent ?? "").slice(0, 40), overflow: s.textOverflow, cut: h.scrollWidth > h.clientWidth + 1 };
    });
    return { frame: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }, sizes, oneSided, rings, titles };
  });

const rect = async (target: Locator) => {
  const b = await target.boundingBox();
  return b === null ? null : { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
};

test("Cmd+T final walk: five states, dark and bright, sizes, edges, ellipsis and focus", async () => {
  test.setTimeout(400_000);
  const junto = await launchJunto({
    windowContentSize: { width: 1500, height: 900 },
    seedModels: { [CANVAS]: modelFixture([modelNode({ kind: "artifacts", id: "notes", label: "Research notes", x: 60, y: 60, width: 300, height: 160, z: 0 })]) },
  });
  const { page } = junto;
  const states: Record<string, unknown> = {};
  const misses: string[] = [];
  const step = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      misses.push(`${name}: ${String(error).replace(/\u001b\[[0-9;]*m/gu, "").split("\n").slice(0, 3).join(" ")}`);
    }
  };
  const frame = async (name: string, extra?: () => Promise<unknown>): Promise<void> => {
    await page.waitForTimeout(400);
    for (const theme of ["dark", "bright"] as const) {
      mkdirSync(join(SHOTS, theme), { recursive: true });
      await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(SHOTS, theme, `${name}.png`) });
      states[`${theme}/${name}`] = { ...(await measure(surface(page))), ...(extra ? { extra: await extra() } : {}) };
    }
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await page.waitForTimeout(200);
  };
  const create = (title: string, markdown: string) =>
    page.evaluate(
      ({ canvas, node, artifactId, opId, title, markdown }) =>
        window.junto!.resource!.artifact!.apply(canvas, node, artifactId as never, opId, { op: "create", title, body: { type: "document", markdown }, labels: [] }),
      { canvas: CANVAS, node: asNodeId("notes"), artifactId: mintItemId(), opId: mintOpId(), title, markdown },
    );
  try {
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await expect(page.locator('.react-flow__node[data-id="notes"]')).toBeVisible({ timeout: 30_000 });

    await step("1 no artifacts yet", async () => {
      await page.locator(".react-flow__pane").click({ position: { x: 1200, y: 700 } });
      await page.keyboard.press("Meta+t");
      await expect(surface(page)).toBeVisible({ timeout: 10_000 });
      await surface(page).getByRole("button", { name: "Make an Inbox", exact: true }).click();
      await expect(entry(page)).toBeFocused({ timeout: 15_000 });
      await frame("1-empty-new-capture", async () => ({ caretInBody: await entry(page).evaluate((el) => el === document.activeElement || el.contains(document.activeElement)), rows: await page.locator(".quick-capture__row").count() }));
      await page.keyboard.type("Roadmap pricing notes");
      await page.keyboard.press("Enter");
      await page.keyboard.type("Quarterly roadmap pricing tiers for launch.");
      await page.waitForTimeout(2500);
      await search(page).click();
      await page.keyboard.press("Escape");
      if (await surface(page).isVisible()) await page.keyboard.press("Meta+t");
      await expect(surface(page)).toBeHidden({ timeout: 5_000 });
    });

    await create(LONG, `# ${LONG}\n\nThe tiers, the partner terms and the rollout dates.`);
    await create("Errands for the week", "# Errands for the week\n\nMilk, eggs, bread and the errands before Friday.");

    await step("2 list with Inbox and recent rows", async () => {
      await page.keyboard.press("Meta+t");
      await expect(surface(page)).toBeVisible({ timeout: 10_000 });
      await expect(page.locator(".quick-capture__row").nth(2)).toBeVisible({ timeout: 10_000 });
      await frame("2-list-inbox-recent", async () => ({ label: await page.locator(".quick-capture__list-label").allInnerTexts(), rows: await page.locator(".quick-capture__row-title").allInnerTexts() }));
    });

    await step("3 preview then Enter", async () => {
      await page.keyboard.press("Meta+l");
      await search(page).fill("errands");
      await expect(page.locator(".quick-capture__row-title").first()).toHaveText("Errands for the week", { timeout: 10_000 });
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowUp");
      await expect(page.locator(".quick-capture__preview-doc, .quick-capture__preview").first()).toContainText("Milk, eggs", { timeout: 5_000 });
      const boxes = async () => ({
        title: await rect(page.locator(".quick-capture__preview-title, .capture-editor .artifact-head__title").first()),
        firstLine: await rect(page.locator(".quick-capture__preview .cm-line, .capture-editor .cm-line").filter({ hasText: "Milk, eggs" }).first()),
      });
      await frame("3a-preview-by-arrows", boxes);
      await page.keyboard.press("Enter");
      await expect(page.locator(".capture-editor .artifact-head__title")).toHaveValue("Errands for the week", { timeout: 10_000 });
      await frame("3b-same-row-after-enter", boxes);
    });

    await step("4 editor focus in body", async () => {
      await page.locator(".capture-editor .cm-content").first().click();
      await frame("4a-editor-body-focused", async () =>
        page.locator(".capture-editor").first().evaluate((el) => {
          const out: Record<string, string> = {};
          for (const e of [el, ...el.querySelectorAll(".cm-editor, .cm-scroller, .cm-content")]) {
            const s = getComputedStyle(e);
            out[[...e.classList].slice(0, 2).join(".") || e.tagName] = `outline ${s.outlineWidth} ${s.outlineStyle} ${s.outlineColor}; shadow ${s.boxShadow}; border ${s.borderTopWidth} ${s.borderTopColor}`;
          }
          return out;
        }),
      );
    });

    await step("4 list keyboard focus", async () => {
      await page.keyboard.press("Meta+l");
      await search(page).fill("");
      await page.waitForTimeout(500);
      await page.keyboard.press("Tab");
      await page.keyboard.press("ArrowDown");
      await frame("4b-list-keyboard-focus", async () => ({ focused: await page.evaluate(() => `${document.activeElement?.tagName}.${[...(document.activeElement?.classList ?? [])].join(".")}`) }));
    });

    await step("5 search", async () => {
      await page.keyboard.press("Meta+l");
      await search(page).fill("pricing");
      await expect(page.locator(".quick-capture__row").first()).toBeVisible({ timeout: 10_000 });
      await frame("5a-search-matches", async () => ({ rows: await page.locator(".quick-capture__row-title").allInnerTexts() }));
      await search(page).fill("zzqqxx nothing");
      await page.waitForTimeout(800);
      await frame("5b-search-no-match", async () => ({ rows: await page.locator(".quick-capture__row").count(), text: await surface(page).innerText() }));
    });
  } finally {
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(join(SHOTS, "measures.json"), JSON.stringify({ states, misses }, null, 2));
    await junto.close();
  }
  console.log("FINAL-MISSES", JSON.stringify(misses));
  expect(misses).toEqual([]);
});
