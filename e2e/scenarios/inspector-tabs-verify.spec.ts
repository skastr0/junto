/**
 * Real app, 572b6c065: the inspector tab's active mark is the amber tint with
 * ink words and a rounded top, no underline; words and badge 10px. Its two
 * users, the agent editor (from the seat toolbar) and the git detail (from a
 * seat's git line), dark and bright, at 1500, 900 and 720 wide (where the agent editor stacks). Each tab row is
 * read for a wrapped tab, a clipped badge, the active tab's fill, border and
 * radius, and how its bottom meets the hairline under the row.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/inspector-tabs-verify.spec.ts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator } from "@playwright/test";
import type { ElectronApplication } from "playwright-core";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelSeat } from "../harness/model";

const CANVAS = "inspector-tabs";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/inspector-tabs-verify";
const env = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" };

const makeRepository = (repo: string): void => {
  const git = (...args: string[]): void => void execFileSync("git", ["-C", repo, ...args], { env });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "parser.ts"), "export const parse = (text: string) => text.split(',');\n");
  git("add", "parser.ts");
  git("commit", "-q", "-m", "Start");
  git("checkout", "-q", "-b", "feat/tabs");
  writeFileSync(join(repo, "parser.ts"), "export const parse = (text: string) => text.split(',').map((p) => p.trim());\n");
  git("commit", "-q", "-am", "Trim the parts");
  writeFileSync(join(repo, "parser.ts"), "export const parse = (text: string) => text.split(',').map((p) => p.trim()).filter(Boolean);\n");
};

const readTabs = (list: Locator) =>
  list.evaluate((row) => {
    const rowBox = row.getBoundingClientRect();
    const rs = getComputedStyle(row);
    return {
      row: { width: Math.round(rowBox.width), bottom: rowBox.bottom, hairline: `${rs.borderBottomWidth} ${rs.borderBottomStyle} ${rs.borderBottomColor}`, scrollWidth: row.scrollWidth, clientWidth: row.clientWidth },
      tabs: [...row.querySelectorAll('[role="tab"]')].map((tab) => {
        const s = getComputedStyle(tab);
        const box = tab.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(tab);
        const lines = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size;
        const badge = tab.querySelector("span.rounded-full") as HTMLElement | null;
        return {
          text: (tab.textContent ?? "").trim(),
          selected: tab.getAttribute("aria-selected"),
          fontSize: s.fontSize,
          height: Math.round(box.height),
          lines,
          clipped: (tab as HTMLElement).scrollWidth > (tab as HTMLElement).clientWidth + 1,
          badge: badge ? { fontSize: getComputedStyle(badge).fontSize, clipped: badge.scrollWidth > badge.clientWidth + 1, text: badge.textContent } : null,
          background: s.backgroundColor,
          borders: `${s.borderTopWidth} ${s.borderRightWidth} ${s.borderBottomWidth} ${s.borderLeftWidth}`,
          shadow: s.boxShadow,
          radius: `${s.borderTopLeftRadius} ${s.borderTopRightRadius} ${s.borderBottomRightRadius} ${s.borderBottomLeftRadius}`,
          gapToHairline: Math.round((rowBox.bottom - Number.parseFloat(rs.borderBottomWidth) - box.bottom) * 10) / 10,
          after: getComputedStyle(tab, "::after").content,
        };
      }),
    };
  });

const setContentSize = (app: ElectronApplication, width: number, height: number): Promise<void> =>
  app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height), { width, height });

test("inspector tabs: agent editor and git detail, dark and bright, 1500, 900 and 720 wide", async () => {
  test.setTimeout(400_000);
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "junto-e2e-tabs-")));
  makeRepository(repo);
  const junto = await launchJunto({
    windowContentSize: { width: 1500, height: 900 },
    seedModels: { [CANVAS]: modelFixture([modelSeat({ id: "atlas", key: "local:tabs-atlas", label: "Atlas", harness: "claude", cwd: repo, x: 60, y: 80 })]) },
  });
  const { page, app } = junto;
  const out: Record<string, unknown> = {};
  const misses: string[] = [];
  const frames = async (name: string, list: Locator): Promise<void> => {
    for (const width of [1500, 900, 720]) {
      await setContentSize(app, width, 900);
      await page.waitForTimeout(600);
      for (const theme of ["dark", "bright"] as const) {
        mkdirSync(join(SHOTS, theme), { recursive: true });
        await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
        await page.waitForTimeout(350);
        await page.screenshot({ path: join(SHOTS, theme, `${name}-${width}.png`) });
        const box = await list.boundingBox();
        if (box) await page.screenshot({ path: join(SHOTS, theme, `${name}-${width}-tabs-crop.png`), clip: { x: Math.max(0, box.x - 12), y: Math.max(0, box.y - 12), width: Math.min(box.width + 24, width - box.x + 12), height: box.height + 40 } });
        out[`${theme}/${name}-${width}`] = await readTabs(list);
      }
    }
    await setContentSize(app, 1500, 900);
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
  };
  const step = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      misses.push(`${name}: ${String(error).replace(/\u001b\[[0-9;]*m/gu, "").split("\n").slice(0, 3).join(" ")}`);
    }
  };
  try {
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    const seat = page.locator('.react-flow__node[data-id="atlas"]');
    await expect(seat).toBeVisible({ timeout: 30_000 });

    await step("agent editor", async () => {
      await seat.click();
      await page.getByTestId("toolbar-customize-agent").click({ timeout: 10_000 });
      const editor = page.getByTestId("agent-editor");
      await expect(editor).toBeVisible({ timeout: 10_000 });
      await frames("1-agent-editor", editor.getByRole("tablist").first());
      // The keyboard onto a tab, at the narrowest: its ring is read against the row's clip.
      await setContentSize(app, 720, 900);
      await page.waitForTimeout(600);
      for (let i = 0; i < 40 && !(await page.evaluate(() => document.activeElement?.getAttribute("role") === "tab")); i += 1) await page.keyboard.press("Tab");
      const ring = await page.evaluate(() => {
        const tab = document.activeElement as HTMLElement;
        if (tab?.getAttribute("role") !== "tab") return null;
        const row = tab.closest('[role="tablist"]') as HTMLElement;
        const s = getComputedStyle(tab);
        const t = tab.getBoundingClientRect();
        const r = row.getBoundingClientRect();
        const reach = Number.parseFloat(s.outlineWidth) + Number.parseFloat(s.outlineOffset);
        return {
          tab: tab.textContent?.trim(),
          focusVisible: tab.matches(":focus-visible"),
          outline: `${s.outlineWidth} ${s.outlineStyle} ${s.outlineColor} offset ${s.outlineOffset}`,
          shadow: s.boxShadow,
          rowOverflow: getComputedStyle(row).overflowX,
          ringInsideRow: t.left - Math.max(reach, 0) >= r.left - 0.5 && t.right + Math.max(reach, 0) <= r.right + 0.5 && t.top - Math.max(reach, 0) >= r.top - 0.5 && t.bottom + Math.max(reach, 0) <= r.bottom + 0.5,
        };
      });
      out["keyboard-focus-720"] = ring;
      for (const theme of ["dark", "bright"] as const) {
        await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
        await page.waitForTimeout(350);
        const box = await editor.getByRole("tablist").first().boundingBox();
        if (box) await page.screenshot({ path: join(SHOTS, theme, "3-agent-editor-720-keyboard-focus-crop.png"), clip: { x: Math.max(0, box.x - 12), y: Math.max(0, box.y - 12), width: Math.min(box.width + 24, 720 - Math.max(0, box.x - 12)), height: box.height + 40 } });
        await page.screenshot({ path: join(SHOTS, theme, "3-agent-editor-720-keyboard-focus.png") });
      }
      await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
      await setContentSize(app, 1500, 900);
      await page.keyboard.press("Escape");
      await expect(editor).toBeHidden({ timeout: 5_000 });
    });

    await step("git detail", async () => {
      await seat.dblclick();
      const surface = page.locator(".workbench-pane:not(.workbench-pane--parked) .native-terminal-surface");
      const line = surface.getByTestId("seat-git-line");
      await expect(line).toBeVisible({ timeout: 20_000 });
      await line.click();
      const detail = page.getByTestId("git-detail");
      await expect(detail).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(800);
      await frames("2-git-detail", detail.getByRole("tablist", { name: "What to show" }));
    });
  } finally {
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(join(SHOTS, "tabs.json"), JSON.stringify({ out, misses }, null, 2));
    await junto.close();
    rmSync(repo, { recursive: true, force: true });
  }
  console.log("TABS-MISSES", JSON.stringify(misses));
  expect(misses).toEqual([]);
});

