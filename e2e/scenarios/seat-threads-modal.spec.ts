/**
 * The seat Threads modal (d7e93b60c): it sizes to the frame, maximizes and
 * folds its list; a message renders as markdown with a mention chip that
 * still opens its seat; a long first line clamps to two lines in the list and
 * one line in the chat header, whole on hover; bubbles use the chat's width;
 * prose is in the body face, names and times in mono.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/seat-threads-modal.spec.ts
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { ElectronApplication } from "playwright-core";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelMessagesWire, modelRegion, modelSeat } from "../harness/model";

const CANVAS = "seat-threads-modal";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/seat-threads-modal";

const atlas = modelSeat({ id: "atlas", key: "local:stm-atlas", label: "Atlas", harness: "claude", x: 40, y: 60 });
const bravo = modelSeat({ id: "bravo", key: "local:stm-bravo", label: "Bravo", harness: "claude", x: 40, y: 260 });
const ops = modelRegion({ id: "ops", label: "Ops", x: 0, y: 0, width: 700, height: 540 });
const nodes = [ops, atlas, bravo];

const LONG_FIRST_LINE =
  "Could you read the whole onboarding flow again before the release goes out, and tell me which of the three welcome screens still talks about the old pricing page, because the copy changed twice last week and I cannot tell which version shipped to the beta group on Tuesday";

const shot = async (page: Page, name: string): Promise<string> => {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(350);
  const path = join(SHOTS, `${name}.png`);
  await page.screenshot({ path });
  return path;
};

const setContentSize = (app: ElectronApplication, width: number, height: number): Promise<void> =>
  app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height), { width, height });

test("seat Threads modal: sizing, markdown, clamps, bubble width and faces", async () => {
  test.setTimeout(300_000);
  const junto = await launchJunto({
    windowContentSize: { width: 1500, height: 900 },
    seedModels: { [CANVAS]: modelFixture(nodes, [modelMessagesWire("w1", "atlas", "bravo", nodes)]) },
  });
  const report: string[] = [];
  const frames: string[] = [];
  try {
    const { app, page } = junto;
    const card = (id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
    await expect(card("atlas")).toBeVisible({ timeout: 30_000 });
    await card("atlas").dblclick();
    await page.getByTestId("seat-threads-button").click();
    const panel = page.locator(".focus-surface__panel").last();
    await expect(page.getByTestId("seat-threads")).toBeVisible({ timeout: 20_000 });

    // Thread one: a long first line, no markup.
    const send = async (text: string, mention?: string): Promise<void> => {
      const input = page.getByTestId("thread-composer-input");
      await input.click();
      await input.fill("");
      if (mention === undefined) {
        await input.fill(text);
      } else {
        const [before, after] = text.split("{@}");
        await input.pressSequentially(`${before}@`);
        await page.getByTestId("mention-option").filter({ hasText: mention }).click();
        await input.pressSequentially(after ?? "");
      }
      await input.press("Enter");
    };
    await page.getByTestId("seat-threads-new").click();
    await send(LONG_FIRST_LINE);
    await expect(page.getByTestId("seat-threads-message")).toHaveCount(1, { timeout: 20_000 });

    // Thread two: markdown, with a mention.
    await page.getByTestId("seat-threads-new").click();
    const input = page.getByTestId("thread-composer-input");
    await input.click();
    await input.pressSequentially("Status with **bold words** and `inline_code`, ask @");
    await page.getByTestId("mention-option").filter({ hasText: "Bravo" }).click();
    await input.pressSequentially(" about it:");
    await input.press("Shift+Enter");
    await input.press("Shift+Enter");
    await input.pressSequentially("- first item");
    await input.press("Shift+Enter");
    await input.pressSequentially("- second item");
    await input.press("Shift+Enter");
    await input.press("Shift+Enter");
    await input.pressSequentially("```");
    await input.press("Shift+Enter");
    await input.pressSequentially("junto msg reply '{\"target\":\"agent-1\",\"text\":\"a line long enough to scroll sideways at any reading size, twice over\"}'");
    await input.press("Shift+Enter");
    await input.pressSequentially("```");
    await input.press("Enter");
    await expect(page.getByTestId("seat-threads-message")).toHaveCount(1, { timeout: 20_000 });
    await expect(page.getByTestId("seat-threads-mention")).toHaveCount(1, { timeout: 20_000 });
    await page.waitForTimeout(500);

    // (1) sizing: widths at three window sizes, then maximize and restore, then the sidebar fold.
    const widthOf = (): Promise<number> => panel.evaluate((el) => (el as HTMLElement).offsetWidth);
    const frameOf = (): Promise<number> => panel.evaluate((el) => el.parentElement!.clientWidth);
    const sizes: Array<[number, number, number]> = [];
    for (const w of [1100, 1500, 1900]) {
      await setContentSize(app, w, 900);
      await page.waitForTimeout(600);
      sizes.push([w, await widthOf(), await frameOf()]);
    }
    report.push(`(1) panel width by window: ${sizes.map(([w, p, f]) => `${w} -> panel ${p} frame ${f}`).join("; ")}`);
    expect(sizes[1]![1], "the modal grows with the window").toBeGreaterThan(sizes[0]![1]);
    await setContentSize(app, 1500, 900);
    await page.waitForTimeout(600);
    frames.push(await shot(page, "1-default-1500"));
    const root = page.locator(".focus-surface").last();
    const before = await widthOf();
    const frame = await frameOf();
    const pad = await root.evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft) + parseFloat(getComputedStyle(el).paddingRight));
    const maximize = panel.getByRole("button", { name: "Maximize" }).first();
    await expect(maximize, "Maximize is offered").toBeVisible();
    await maximize.click();
    await expect(root).toHaveAttribute("data-maximized", "true");
    await page.waitForTimeout(500);
    const big = await widthOf();
    report.push(`(1) default ${before}, maximized ${big}, frame ${frame}, padding ${pad}`);
    expect(big).toBeGreaterThanOrEqual(frame - pad - 2);
    frames.push(await shot(page, "2-maximized"));
    await maximize.click();
    await expect(root).not.toHaveAttribute("data-maximized", "true");
    await page.waitForTimeout(500);
    expect(Math.abs((await widthOf()) - before), "Restore returns the width").toBeLessThanOrEqual(1.5);
    const aside = panel.getByRole("complementary").first();
    const listWide = (await aside.boundingBox())?.width ?? 0;
    const toggle = panel.locator("[data-sidebar-toggle]").first();
    await toggle.click();
    await expect(panel.locator("[data-sidebar-toggle]").filter({ visible: true }).first()).toHaveAttribute("aria-expanded", "false");
    await page.waitForTimeout(400);
    const listNarrow = (await aside.boundingBox())?.width ?? 0;
    report.push(`(1) list width ${Math.round(listWide)} -> ${Math.round(listNarrow)} when folded`);
    expect(listNarrow).toBeLessThan(listWide / 2);
    frames.push(await shot(page, "3-sidebar-folded"));
    await panel.locator("[data-sidebar-toggle]").filter({ visible: true }).first().click();
    await expect(panel.locator("[data-sidebar-toggle]").first()).toHaveAttribute("aria-expanded", "true");
    await page.waitForTimeout(400);

    // (2) markdown renders, the mention is a chip that opens its seat.
    const message = page.getByTestId("seat-threads-message").first();
    const prose = message.locator(".seat-threads__prose");
    const html = await prose.innerHTML();
    const text = await prose.innerText();
    report.push(`(2) rendered text: ${JSON.stringify(text)}`);
    expect(html).toMatch(/<strong[^>]*>bold words<\/strong>/);
    expect(html).toMatch(/<code[^>]*>inline_code<\/code>/);
    expect(html).toMatch(/<li[^>]*>[\s\S]*first item/);
    const bullets = await prose.locator("li").first().evaluate((li) => {
      const cs = getComputedStyle(li);
      const ul = li.parentElement!;
      return { display: cs.display, listStyleType: cs.listStyleType, parentListStyle: getComputedStyle(ul).listStyleType, padLeft: getComputedStyle(ul).paddingLeft };
    });
    report.push(`(2) list item style: ${JSON.stringify(bullets)}`);
    expect(bullets.display, "list items are list items").toBe("list-item");
    expect(bullets.listStyleType === "none" && bullets.parentListStyle === "none", "markdown lists show bullets").toBe(false);
    expect(text, "no raw asterisks").not.toContain("**");
    expect(text, "no raw backticks").not.toContain("`");
    const chip = page.getByTestId("seat-threads-mention").first();
    await expect(chip).toContainText("Bravo");
    // A fenced block scrolls sideways, so it takes the keyboard and wears the ring.
    const well = page.locator(".seat-threads__prose pre").first();
    await expect(well).toHaveAttribute("tabindex", "0");
    await well.focus();
    const wellRing = await well.evaluate((el) => getComputedStyle(el).boxShadow);
    report.push(`(2) code well tabindex 0, focus ring ${wellRing}`);
    expect(wellRing, "the code well shows the house ring when focused").toContain("inset");
    frames.push(await shot(page, "4-markdown-message"));
    await chip.click();
    await expect(page.getByTestId("seat-threads")).toHaveCount(0, { timeout: 10_000 });
    report.push("(2) the mention chip opened its seat and left Threads");
    // The chip took the operator to Bravo's modal. Close every modal and come back to Atlas's Threads.
    await expect(page.locator(".focus-surface__panel").last()).toContainText("Bravo", { timeout: 10_000 });
    frames.push(await shot(page, "4b-chip-opened-bravo"));
    for (let i = 0; i < 3 && (await page.locator(".focus-surface").count()) > 0; i += 1) {
      await page.keyboard.press("Meta+w");
      await page.waitForTimeout(400);
    }
    await expect(page.locator(".focus-surface")).toHaveCount(0, { timeout: 10_000 });
    await card("atlas").dblclick();
    await page.getByTestId("seat-threads-button").click();
    await expect(page.getByTestId("seat-threads")).toBeVisible({ timeout: 20_000 });

    // (3) list row clamp and header subject.
    const rows = page.getByTestId("seat-threads-row");
    await expect(rows).toHaveCount(2);
    const longRow = rows.filter({ hasText: "onboarding flow" }).first();
    const clamp = await longRow.locator(".seat-threads__row-preview").evaluate((el) => {
      const cs = getComputedStyle(el);
      const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3;
      return { height: el.clientHeight, scrollHeight: el.scrollHeight, lineHeight: line, lines: Math.round(el.clientHeight / line), clamp: cs.getPropertyValue("-webkit-line-clamp") };
    });
    const meta = await longRow.locator(".seat-threads__row-top").innerText();
    const order = await longRow.evaluate((el) => {
      const t = el.querySelector(".seat-threads__row-preview")!.getBoundingClientRect();
      const m = el.querySelector(".seat-threads__row-top")!.getBoundingClientRect();
      return { titleBottom: t.bottom, metaTop: m.top, metaBottom: m.bottom, previewTop: t.top };
    });
    report.push(`(3) list row preview ${JSON.stringify(clamp)}; author line ${JSON.stringify(meta)}; author line sits above the words: ${order.previewTop >= order.metaBottom - 1}`);
    expect(clamp.scrollHeight, "the long first line overflows its box, so it is clamped").toBeGreaterThan(clamp.height + 1);
    expect(clamp.lines, "two lines at most").toBeLessThanOrEqual(2);
    expect(order.previewTop).toBeGreaterThanOrEqual(order.metaBottom - 1);
    await longRow.click();
    await expect(page.getByTestId("seat-threads-message")).toHaveCount(1, { timeout: 15_000 });
    const head = await page.locator(".seat-threads__chat-title").evaluate((el) => {
      const cs = getComputedStyle(el);
      const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3;
      return { title: el.getAttribute("data-junto-tooltip") ?? el.getAttribute("title") ?? "", shown: el.textContent ?? "", clientWidth: el.clientWidth, scrollWidth: el.scrollWidth, height: el.clientHeight, lineHeight: line, whiteSpace: cs.whiteSpace, overflow: cs.textOverflow };
    });
    report.push(`(3) header: whiteSpace ${head.whiteSpace}, textOverflow ${head.overflow}, height ${head.height} (line ${Math.round(head.lineHeight)}), hover text length ${head.title.length}, shown length ${head.shown.length}`);
    expect(head.height, "one line").toBeLessThanOrEqual(head.lineHeight * 1.5);
    expect(head.title, "the whole text is on hover").toContain("because the copy changed twice last week");
    frames.push(await shot(page, "5-long-thread-clamps"));

    // (4) bubble width and faces, in the default size and maximized.
    const measure = async (label: string): Promise<void> => {
      const m = await page.evaluate(() => {
        const stream = document.querySelector('[data-testid="seat-threads-stream"]') as HTMLElement;
        const bubble = (document.querySelector(".seat-threads__block") ?? document.querySelector(".seat-threads__body")) as HTMLElement;
        const prose = document.querySelector(".seat-threads__prose") as HTMLElement;
        const name = document.querySelector(".seat-threads__message-head") as HTMLElement;
        const probe = (family: string) => {
          const el = document.createElement("span");
          el.style.fontFamily = family;
          document.body.appendChild(el);
          const v = getComputedStyle(el).fontFamily;
          el.remove();
          return v;
        };
        const nameParts = [...name.querySelectorAll("*")].map((e) => ({ t: (e.textContent ?? "").slice(0, 16), f: getComputedStyle(e).fontFamily }));
        return {
          streamWidth: stream.clientWidth,
          bubbleWidth: bubble.getBoundingClientRect().width,
          prose: getComputedStyle(prose).fontFamily,
          body: probe("var(--font-body)"),
          mono: probe("var(--font-mono)"),
          head: getComputedStyle(name).fontFamily,
          nameParts,
        };
      });
      const ratio = m.bubbleWidth / m.streamWidth;
      const lines = await page.evaluate(() => {
        const prose = document.querySelector(".seat-threads__prose") as HTMLElement;
        const range = document.createRange();
        range.selectNodeContents(prose);
        // Characters per visual line, counted by walking the text and noting where the top changes.
        const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT);
        const perLineList: number[] = [];
        let currentTop = -1;
        let count = 0;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node.textContent ?? "";
          for (let i = 0; i < text.length; i += 1) {
            range.setStart(node, i);
            range.setEnd(node, i + 1);
            const rect = range.getClientRects()[0];
            if (!rect) continue;
            const top = Math.round(rect.top);
            if (currentTop !== -1 && top > currentTop + 4) {
              perLineList.push(count);
              count = 0;
            }
            currentTop = top;
            count += 1;
          }
        }
        perLineList.push(count);
        const tops = new Set(perLineList.map((_, i) => i));
        const chars = (prose.textContent ?? "").length;
        const proseBox = prose.getBoundingClientRect();
        const blockCs = getComputedStyle(prose.closest(".seat-threads__block, .seat-threads__body")!);
        const textWidth = proseBox.width;
        const block = { background: blockCs.backgroundColor, border: blockCs.borderTopColor, radius: blockCs.borderTopLeftRadius };
        const font = getComputedStyle(prose).fontSize;
        const title = getComputedStyle(document.querySelector(".seat-threads__chat-title")!).fontFamily;
        const probe = document.createElement("span");
        probe.style.fontFamily = "var(--font-body)";
        document.body.appendChild(probe);
        const body = getComputedStyle(probe).fontFamily;
        probe.remove();
        return { lines: tops.size, chars, perLine: Math.max(...perLineList), perLineList, textWidth: Math.round(textWidth), font, title, body, block };
      });
      report.push(`(4) ${label}: ${lines.lines} lines, ${lines.chars} characters, lines of ${JSON.stringify(lines.perLineList)} characters (longest ${lines.perLine}), text column ${lines.textWidth}px at ${lines.font}; chat title face ${lines.title === lines.body ? "body (proportional)" : "NOT body"} (${lines.title.slice(0, 40)}); operator block ${JSON.stringify(lines.block)}`);
      expect(lines.title, "the chat title is in the body face").toBe(lines.body);
      // 34em: the measure follows the reading size, so a line stays 66 to 72 characters.
      expect(lines.textWidth, "the text column holds the 34em measure").toBeLessThanOrEqual(545);
      expect(lines.font, "prose is the reading step").toBe("16px");
      expect(lines.perLine, "a line is 66 to 72 characters").toBeLessThanOrEqual(80);
      report.push(`(4) ${label}: bubble ${Math.round(m.bubbleWidth)} of chat ${m.streamWidth} = ${ratio.toFixed(3)}; prose face ${m.prose === m.body ? "body" : "NOT body"} (${m.prose.slice(0, 40)}); head face ${m.head === m.mono ? "mono" : "NOT mono"} (${m.head.slice(0, 40)}); parts ${JSON.stringify(m.nameParts)}`);
      expect(ratio, "bubble reaches up to 92% of the chat").toBeLessThanOrEqual(0.93);
      expect(m.prose, "prose is in the body face").toBe(m.body);
      expect(m.head, "names and times are mono").toBe(m.mono);
    };
    await measure("default 1500");
    await panel.getByRole("button", { name: "Maximize" }).first().click();
    await page.waitForTimeout(500);
    await measure("maximized");
    frames.push(await shot(page, "6-long-thread-maximized"));
    console.log("REPORT\n" + report.join("\n"));
    console.log("FRAMES\n" + frames.join("\n"));
  } finally {
    console.log("PARTIAL REPORT\n" + report.join("\n"));
    await junto.close();
  }
});
