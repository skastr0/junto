/**
 * Threads B2 in the real app with real-length mail, dark and bright, at
 * 1500x900 and 1280x800: the reading column, seat prose unboxed, the
 * operator's messages on the right under You, quotes, code wells, id tokens,
 * list rows with the latest words, unread and selected rows, the composer and
 * the keyboard order.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/threads-b2-verify.spec.ts
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { ElectronApplication } from "playwright-core";
import { expect, launchJunto, test } from "../harness/launch";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { modelFixture, modelRegion, modelSeat, modelWire } from "../harness/model";

const CANVAS = "threads-b2";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? join("test-results", "threads-b2");

const scout = modelSeat({ id: "scout", key: "local:tb2-scout", label: "Scout", harness: "codex", cwd: mkdtempSync(join(tmpdir(), "junto-tb2-scout-")), x: 40, y: 60 });
const ada = modelSeat({ id: "ada", key: "local:tb2-ada", label: "Ada", harness: "codex", cwd: mkdtempSync(join(tmpdir(), "junto-tb2-ada-")), x: 400, y: 60 });
const nodes = [modelRegion({ id: "ops", label: "Ops", x: 0, y: 0, width: 900, height: 420 }), scout, ada];

const OPERATOR_ASK = [
  "Go for the Threads walk and one more check. Tests load again (67b3f5f85, 455 specs), and the inline code fix is in (4ccb38604). Build once from local main HEAD.",
  "",
  "> Proof that decides something, nothing more: one non-author review per change, the tests that cover what you changed.",
  "",
  "- Threads B2, dark and bright, 1500x900 and 1280x800",
  "- the v71 to v72 upgrade on a copy of `~/.junto/state/junto.db`",
  "",
  "Reply on message 01M65TJP2EZPAJBV7RKAAKM5HX when it is done.",
].join("\n");

const ADA_FIRST = [
  "0.11.6 walk part 1, native CLI: PASS, with one unlisted wording change for cli-lead. The build is 89f6932a9, unsigned, ship profile, with bin/junto as the native Mach-O.",
  "",
  "I ran the same 58 live calls as real seats in the packaged app, once on 0.11.5 and once on 0.11.6, and diffed them after normalizing ids, times and paths. 47 of 58 are byte-identical. The one that matters:",
  "",
  "```ts",
  "// before: {\"type\":\"InputError\",\"message\":\"Expected a valid JSON string\"}",
  "// after:  {\"type\":\"InputError\",\"message\":\"key must be a string at line 1 column 2\"}",
  "const same = before.type === after.type && before.details.path === after.details.path;",
  "```",
  "",
  "Frames and the diff are in walk2-0116 and walk2-diff.txt.",
].join("\n");

const ADA_SECOND = [
  "One more, from the first run: a seat woken mid-send got `AuthError` 'process identity became stale' while its mail did land, so a retry would duplicate it. That is app-side (control.ts:2750) and in 0.11.5 too, so it is not the cutover.",
  "",
  "> a retry would duplicate it",
  "",
  "Sent to pty-lead with the thread id 01M65QV5FYN4DMTRAHA6SF5CMK.",
].join("\n");

const SCOUT_MAIL = [
  "Measure request at 41ba33592 or later: Files quick open latency on the 40k-path fixture, cold and warm, p50 and p95 over 20 opens each.",
  "",
  "- cold: first open after launch",
  "- warm: the same query typed again",
  "",
  "The number that decides it is warm p95 under 16 ms.",
].join("\n");

const report: string[] = [];
const note = (line: string): void => {
  report.push(line);
  console.log(`TB2 ${line}`);
};

const setContentSize = (app: ElectronApplication, width: number, height: number): Promise<void> =>
  app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height), { width, height });

const shot = async (page: Page, name: string): Promise<void> => {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

const setTheme = async (page: Page, mode: "dark" | "bright"): Promise<void> => {
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.locator(".settings-nav__item", { hasText: "Appearance" }).click();
  const choice = page.getByRole("radiogroup", { name: "Theme", exact: true }).getByRole("radio", { name: mode === "bright" ? "Bright" : "Dark", exact: true });
  await choice.click();
  await expect(choice).toHaveAttribute("aria-checked", "true");
  await page.locator(".settings-panel__close").click();
  await page.waitForTimeout(400);
};

test("Threads B2 reads real-length mail as a column, in both themes and two window sizes", async () => {
  test.setTimeout(600_000);
  const junto = await launchJunto({
    windowContentSize: { width: 1500, height: 900 },
    seedModels: { [CANVAS]: modelFixture(nodes, [modelWire("e-scout-ada", "scout", "ada", "messages", nodes), modelWire("e-ada-scout", "ada", "scout", "messages", nodes)]) },
    afterSeed: installCrewSeatHarness,
  });
  try {
    const { app, page, sandbox } = junto;
    const adaCard = page.locator(`.react-flow__node[data-id="ada"]`);
    await expect(adaCard).toBeVisible({ timeout: 30_000 });
    await setTheme(page, "dark");
    await crewPlayFactory(page);
    const scoutSeat = crewSeat(sandbox, CANVAS, "scout");
    const adaSeat = crewSeat(sandbox, CANVAS, "ada");
    await crewOccupySeat(page, CANVAS, scout, scoutSeat);
    await crewOccupySeat(page, CANVAS, ada, adaSeat);
    expect((await scoutSeat.op("onboard", {})).ok).toBe(true);
    expect((await adaSeat.op("onboard", {})).ok).toBe(true);
    const sent = await scoutSeat.cli(["msg", "send", JSON.stringify({ target: "Ada", text: SCOUT_MAIL })]);
    expect(sent.exitCode, sent.stderr.slice(0, 300)).toBe(0);

    const trigger = page.getByTestId("seat-threads-button");
    const closeAll = async (): Promise<void> => {
      for (let i = 0; i < 3; i += 1) {
        if ((await page.locator(".focus-surface").count()) === 0) return;
        const close = page.locator(".focus-surface").last().getByRole("button", { name: /^close/i }).first();
        if (await close.isVisible().catch(() => false)) await close.click({ timeout: 5000 });
        else await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
      }
    };
    const openThreads = async (): Promise<void> => {
      if (!(await trigger.isVisible().catch(() => false))) {
        await adaCard.dblclick();
        await expect(trigger).toBeVisible({ timeout: 30_000 });
      }
      await trigger.click();
      await expect(page.getByTestId("seat-threads")).toBeVisible({ timeout: 20_000 });
    };

    // The operator opens a thread with Ada, real length, quote and list and an id.
    await adaCard.dblclick();
    await openThreads();
    await page.getByTestId("seat-threads-new").click();
    const input = page.getByTestId("thread-composer-input");
    await input.click();
    await input.fill(OPERATOR_ASK);
    await input.press("Enter");
    await expect(page.getByTestId("seat-threads-message")).toHaveCount(1, { timeout: 20_000 });
    await closeAll();

    // Ada answers twice in a run, then once more in a second thread the operator opened.
    const listed = await adaSeat.cli(["msg", "list", "{}"]);
    let parentId: string | undefined;
    const walk = (value: unknown): void => {
      if (parentId !== undefined || value === null || typeof value !== "object") return;
      const row = value as Record<string, unknown>;
      if (typeof row.messageId === "string" && JSON.stringify(row).includes("Go for the Threads walk")) {
        parentId = row.messageId;
        return;
      }
      for (const child of Object.values(row)) walk(child);
    };
    walk(JSON.parse(listed.stdout));
    expect(parentId, listed.stdout.slice(0, 400)).toBeDefined();
    for (const text of [ADA_FIRST, ADA_SECOND]) {
      const r = await adaSeat.cli(["msg", "reply", JSON.stringify({ target: "operator", inReplyTo: parentId, text })]);
      expect(r.exitCode, r.stderr.slice(0, 300) + r.stdout.slice(0, 300)).toBe(0);
    }
    await adaCard.dblclick();
    await openThreads();
    await page.getByTestId("seat-threads-new").click();
    await input.click();
    await input.fill("Short one: is the cut smoke still on your list for tonight?");
    await input.press("Enter");
    await expect(page.getByTestId("seat-threads-message")).toHaveCount(1, { timeout: 20_000 });
    await closeAll();
    const listed2 = await adaSeat.cli(["msg", "list", JSON.stringify({ text: "cut smoke" })]);
    const second = /"messageId":"([0-9A-Z]{26})"/.exec(listed2.stdout)?.[1];
    const r2 = await adaSeat.cli(["msg", "reply", JSON.stringify({ target: "operator", inReplyTo: second, text: "Yes. It runs once product-releases calls the cut, with the msg sent, msg list and since checks canvas-lead asked for." })]);
    expect(r2.exitCode, r2.stderr.slice(0, 300)).toBe(0);

    // Open on the long thread: it reads, the short one stays unread.
    await adaCard.dblclick();
    await expect(trigger).toBeVisible({ timeout: 30_000 });
    await openThreads();
    const rows = page.getByTestId("seat-threads-row");
    await expect(rows).toHaveCount(3, { timeout: 20_000 });
    const longRow = rows.filter({ hasText: "One more, from the first run" });
    await longRow.click();
    await expect(longRow).toHaveAttribute("data-selected", "true");
    await expect(page.getByTestId("seat-threads-message")).toHaveCount(3, { timeout: 20_000 });
    // A new answer in the other thread while this one is on screen: that row goes unread.
    const r3 = await adaSeat.cli(["msg", "reply", JSON.stringify({ target: "operator", inReplyTo: second, text: "Also: the backup worker shows in the probe as junto-state-backup, so I can time it from main." })]);
    expect(r3.exitCode, r3.stderr.slice(0, 300)).toBe(0);
    await expect(page.locator("[data-testid='seat-threads-row'][data-unread='true']")).toHaveCount(1, { timeout: 20_000 });

    // Measures, once: the column, unboxed seat prose, the operator's block, quotes, wells, ids.
    const m = await page.getByTestId("seat-threads").evaluate((root) => {
      const css = (el: Element | null) => (el ? getComputedStyle(el) : undefined);
      const column = root.querySelector(".seat-threads__column")!;
      const body = root.querySelector("[data-testid='seat-threads-message']:not([data-mine]) .seat-threads__body");
      const mine = root.querySelector("[data-testid='seat-threads-message'][data-mine] .seat-threads__block");
      const prose = root.querySelector(".seat-threads__prose p");
      const pre = root.querySelector(".seat-threads__prose pre");
      const inline = root.querySelector(".seat-threads__prose :not(pre) > code");
      const quote = root.querySelector(".seat-threads__prose blockquote");
      const colBox = column.getBoundingClientRect();
      const mineBox = mine?.getBoundingClientRect();
      const ch = (() => {
        const span = document.createElement("span");
        span.textContent = "0".repeat(100);
        span.style.font = css(prose)!.font;
        span.style.position = "absolute";
        document.body.appendChild(span);
        const w = span.getBoundingClientRect().width / 100;
        span.remove();
        return w;
      })();
      const unread = root.querySelector("[data-testid='seat-threads-row'][data-unread='true']");
      const selected = root.querySelector("[data-testid='seat-threads-row'][data-selected='true']");
      return {
        columnWidth: Math.round(colBox.width),
        charsPerLine: Math.round(colBox.width / ch),
        proseSize: css(prose)?.fontSize,
        proseLeading: css(prose)?.lineHeight,
        seatBody: { border: css(body)?.borderStyle, background: css(body)?.backgroundColor, padding: css(body)?.padding },
        mineRightGap: mineBox ? Math.round(colBox.right - mineBox.right) : -1,
        mineLeftGap: mineBox ? Math.round(mineBox.left - colBox.left) : -1,
        mineHead: root.querySelector("[data-mine] .seat-threads__message-head strong")?.textContent,
        quote: quote ? { border: `${css(quote)!.borderLeftWidth} ${css(quote)!.borderLeftStyle}`, text: quote.textContent?.trim().slice(0, 40) } : null,
        codeWell: pre ? { tabIndex: (pre as HTMLElement).tabIndex, background: css(pre)!.backgroundColor, border: css(pre)!.borderStyle, fontSize: css(pre)!.fontSize } : null,
        inlineCode: inline ? { background: css(inline)!.backgroundColor, border: css(inline)!.borderStyle, fontSize: css(inline)!.fontSize, text: inline.textContent } : null,
        ids: ["67b3f5f85", "4ccb38604", "01M65TJP2EZPAJBV7RKAAKM5HX", "89f6932a9", "01M65QV5FYN4DMTRAHA6SF5CMK"].map((id) => [id, (root.textContent ?? "").includes(id)]),
        unreadRow: unread ? { weight: css(unread.querySelector(".seat-threads__row-preview"))!.fontWeight, pill: unread.querySelector("[data-testid='seat-threads-row-unread']")?.textContent } : null,
        selectedRow: selected ? { border: `${css(selected)!.borderTopWidth} ${css(selected)!.borderTopStyle} ${css(selected)!.borderTopColor}`, sides: [css(selected)!.borderLeftWidth, css(selected)!.borderRightWidth, css(selected)!.borderBottomWidth] } : null,
        previews: [...root.querySelectorAll("[data-testid='seat-threads-row']")].map((r) => [r.querySelector(".seat-threads__row-who")?.textContent, r.querySelector(".seat-threads__row-preview")?.textContent?.slice(0, 60)]),
      };
    });
    note(`measures: ${JSON.stringify(m)}`);

    // Keyboard order from the list's first control.
    await page.getByTestId("seat-threads-new").focus();
    const order: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      order.push(
        await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el) return "none";
          return [el.tagName.toLowerCase(), el.getAttribute("data-testid") ?? "", el.getAttribute("aria-label") ?? "", (el.textContent ?? "").trim().slice(0, 24)].filter(Boolean).join(" ");
        }),
      );
      await page.keyboard.press("Tab");
    }
    note(`tab order: ${order.join(" | ")}`);

    for (const mode of ["dark", "bright"] as const) {
      if (mode === "bright") {
        await closeAll();
        await setTheme(page, "bright");
        await adaCard.dblclick();
        await openThreads();
        await page.getByTestId("seat-threads-row").filter({ hasText: "One more, from the first run" }).click();
      }
      for (const [w, h] of [[1500, 900], [1280, 800]] as const) {
        await setContentSize(app, w, h);
        await page.waitForTimeout(700);
        await page.mouse.move(4, h - 4);
        await shot(page, `${mode}-${w}-1-reading-column`);
        const stream = page.getByTestId("seat-threads-stream");
        await stream.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
        await shot(page, `${mode}-${w}-2-run-and-code-well`);
        await page.locator(".seat-threads__prose pre").first().focus();
        await shot(page, `${mode}-${w}-3-code-well-focused`);
        await page.getByTestId("thread-composer-input").focus();
        await page.getByTestId("thread-composer-input").fill("Thanks, landing it now.");
        await shot(page, `${mode}-${w}-4-composer`);
        await page.getByTestId("thread-composer-input").fill("");
      }
      await setContentSize(app, 1500, 900);
      // The between-seats thread: read only, Scout's words unboxed.
      await page.getByTestId("seat-threads-between-seats").getByTestId("seat-threads-row").first().click();
      await expect(page.getByTestId("seat-threads-readonly")).toBeVisible({ timeout: 10_000 });
      await shot(page, `${mode}-1500-5-between-seats-readonly`);
      await page.getByTestId("seat-threads-row").filter({ hasText: "One more, from the first run" }).click();
    }
  } finally {
    console.log(`TB2-REPORT\n${report.join("\n")}`);
    await junto.close();
  }
});
