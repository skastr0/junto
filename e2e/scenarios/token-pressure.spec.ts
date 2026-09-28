/**
 * Token pressure [fake-tui]: a running seat past its context limit is told to
 * offboard, once, between turns, as Junto mail on the ordinary delivery path.
 *   electron-vite build
 *   bun run test:e2e:fast e2e/scenarios/token-pressure.spec.ts
 *
 * The seat is the crew fixture's planted `codex`. Its session id is on the
 * node, and a Codex rollout recorded from a real session (sanitized, tests/
 * fixtures/token-pressure) sits under the sandbox home's ~/.codex, so main
 * reads 197k tokens against this seat's own 10k limit. Evidence: the nudge
 * on the seat's input exactly once, its delivery receipt, the gauge in the
 * seat panel, and the context section in Customize. Frames land in
 * test-results/token-pressure/ (disposable, never committed).
 */
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { AgentSeatStateEvent } from "../../src/shared/agent-seat-state";
import { expect, launchJunto, test } from "../harness/launch";
import {
  crewDoc,
  crewOccupySeat,
  crewPlayFactory,
  crewReceipts,
  crewSeat,
  crewSeatNode,
  installCrewSeatHarness,
} from "../harness/crew-fixture";
import type { Sandbox } from "../harness/sandbox";

const CANVAS = "token-pressure";
const SHOTS = join(process.cwd(), "test-results", "token-pressure");
const SEAT = "seat-full";
const THREAD = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";

const base = crewSeatNode({ id: SEAT, label: "Ada", x: 160, y: 220 });
const seatNode = {
  ...base,
  ether: {
    ...base.ether!,
    terminal: { ...base.ether!.terminal!, sessionId: THREAD, tokenPressure: { kind: "tokens" as const, tokens: 10_000 } },
  },
};

/** The rollout lands after the seat is up, so its spawn is a fresh session. */
const plantRollout = async (sandbox: Sandbox): Promise<void> => {
  const dir = join(sandbox.homeDir, ".codex", "sessions", "2026", "09", "26");
  await mkdir(dir, { recursive: true });
  await copyFile(
    join(process.cwd(), "tests", "fixtures", "token-pressure", "codex-rollout.jsonl"),
    join(dir, `rollout-2026-09-26T13-19-10-${THREAD}.jsonl`),
  );
};

const seatState = async (page: Page, bindingId: string): Promise<string | undefined> => {
  const events = (await page.evaluate(() => window.junto!.agentSeatStateSnapshot())) as ReadonlyArray<AgentSeatStateEvent>;
  return events.find((event) => event.bindingId === bindingId)?.state;
};

const NUDGE = "Your context is at 197k tokens, past this seat's limit of 10k.";

const count = (log: string, text: string): number => log.split(text).length - 1;

test("[fake-tui] a seat past its limit is told to offboard once, between turns", async () => {
  test.setTimeout(240_000);
  await mkdir(SHOTS, { recursive: true });
  const junto = await launchJunto({
    seedCanvases: { [CANVAS]: crewDoc([seatNode]) },
    afterSeed: installCrewSeatHarness,
  });
  try {
    const { page, sandbox } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(page);
    const ada = crewSeat(sandbox, CANVAS, SEAT);
    await crewOccupySeat(page, CANVAS, seatNode, ada);
    await expect.poll(() => seatState(page, `local:${SEAT}`), { timeout: 30_000 }).toBe("idle");
    await plantRollout(sandbox);

    // The nudge is typed in as Junto mail and receipted on the seat's mailbox.
    await expect.poll(async () => (await ada.stdinLog()).includes(NUDGE), { timeout: 60_000 }).toBe(true);
    const log = await ada.stdinLog();
    expect(log).toContain("mail from Junto");
    expect(log).toContain('junto offboard "<notes>"');
    await expect
      .poll(async () => (await crewReceipts(page, CANVAS, SEAT)).some((row) => row.deliveredAt !== undefined), {
        timeout: 30_000,
      })
      .toBe(true);

    // The seat panel shows the pressure against this seat's own limit.
    await page.locator(`.react-flow__node[data-id="${SEAT}"]`).click();
    const gauge = page.locator(".rts-cmd-head").getByTestId("seat-pressure");
    await expect(gauge).toContainText("197k of 10k");
    await expect(gauge).toHaveAttribute("data-over", "true");
    await expect(gauge).toContainText("asked to offboard");
    await page.screenshot({ path: join(SHOTS, "seat-panel-gauge-bright.png") });

    // Once per crossing: three more ticks (5s each) with the seat idle and
    // still over the limit bring no second nudge.
    await page.waitForTimeout(16_000);
    expect(count(await ada.stdinLog(), NUDGE)).toBe(1);

    // Customize, context: the live gauge and this seat's own limit.
    await page.getByTestId("toolbar-customize-agent").click();
    const editor = page.getByTestId("agent-editor");
    await editor.getByRole("tab", { name: "context" }).click();
    const section = editor.getByTestId("seat-context-section");
    await expect(section.getByTestId("seat-pressure")).toContainText("197k of 10k");
    await expect(section.getByRole("textbox", { name: "This seat's limit, tokens" })).toHaveValue("10,000");
    await page.screenshot({ path: join(SHOTS, "customize-context-bright.png") });
    await page.keyboard.press("Escape");
    await expect(editor).toBeHidden();

    // The same two surfaces in the dark theme, and the Settings default.
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.locator(".settings-nav__item", { hasText: "Appearance" }).click();
    const dark = page.getByRole("radiogroup", { name: "Theme", exact: true }).getByRole("radio", { name: "Dark", exact: true });
    await dark.click();
    await expect(dark).toHaveAttribute("aria-checked", "true");
    await page.locator(".settings-nav__item", { hasText: "Context" }).click();
    const settings = page.getByTestId("context-settings");
    await expect(settings.getByRole("textbox", { name: "Default limit, percent" })).toHaveValue("75");
    await page.screenshot({ path: join(SHOTS, "settings-context-dark.png") });
    await page.locator(".settings-panel__close").click();
    await page.locator(`.react-flow__node[data-id="${SEAT}"]`).click();
    await expect(gauge).toContainText("197k of 10k");
    await page.screenshot({ path: join(SHOTS, "seat-panel-gauge-dark.png") });
    await page.getByTestId("toolbar-customize-agent").click();
    await editor.getByRole("tab", { name: "context" }).click();
    await expect(section.getByTestId("seat-pressure")).toContainText("197k of 10k");
    await page.screenshot({ path: join(SHOTS, "customize-context-dark.png") });
  } finally {
    await junto.close();
  }
});
