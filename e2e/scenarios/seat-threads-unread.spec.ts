/**
 * The seat Threads button carries what the operator has not read, and the
 * popup reads the thread it shows (0.11.3): a peer's two mails leave two
 * threads unread, the button counts them, opening the popup marks the thread
 * on screen read so its row falls quiet and the count falls by one, and a
 * mark never blanks a row that is still unread.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/seat-threads-unread.spec.ts
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, launchJunto, test } from "../harness/launch";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { modelFixture, modelRegion, modelSeat, modelWire } from "../harness/model";

const CANVAS = "seat-threads-unread";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? join("test-results", "seat-threads-unread");

const scout = modelSeat({
  id: "scout",
  key: "local:stu-scout",
  label: "Scout",
  harness: "codex",
  cwd: mkdtempSync(join(tmpdir(), "junto-stu-scout-")),
  x: 40,
  y: 60,
});
const ada = modelSeat({
  id: "ada",
  key: "local:stu-ada",
  label: "Ada",
  harness: "codex",
  cwd: mkdtempSync(join(tmpdir(), "junto-stu-ada-")),
  x: 360,
  y: 60,
});
const nodes = [modelRegion({ id: "ops", label: "Ops", x: 0, y: 0, width: 900, height: 520 }), scout, ada];

const shot = async (page: Page, name: string): Promise<string> => {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(350);
  const path = join(SHOTS, `${name}.png`);
  await page.screenshot({ path });
  return path;
};

test("the Threads button counts what is unread, and the popup reads the thread it shows", async () => {
  test.setTimeout(300_000);
  const junto = await launchJunto({
    windowContentSize: { width: 1400, height: 860 },
    seedModels: { [CANVAS]: modelFixture(nodes, [modelWire("e-scout-ada", "scout", "ada", "messages", nodes)]) },
    afterSeed: installCrewSeatHarness,
  });
  try {
    const { page, sandbox } = junto;
    await expect(page.locator(`.react-flow__node[data-id="ada"]`)).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(page);
    const seat = crewSeat(sandbox, CANVAS, "scout");
    await crewOccupySeat(page, CANVAS, scout, seat);
    expect((await seat.op("onboard", {})).ok, "scout onboards").toBe(true);

    // Two mails, two threads: Ada's operator has read neither.
    for (const text of ["Read the release notes before standup?", "And the pricing page changed twice."]) {
      const sent = await seat.cli(["msg", "send", JSON.stringify({ target: "Ada", text })]);
      expect(sent.exitCode, sent.stderr.slice(0, 300)).toBe(0);
    }

    // Ada's seat: the header button says what is waiting there.
    await page.locator(`.react-flow__node[data-id="ada"]`).dblclick();
    const trigger = page.getByTestId("seat-threads-button");
    await expect(trigger).toBeVisible({ timeout: 30_000 });
    await expect(trigger).toHaveAttribute("data-unread", "true", { timeout: 30_000 });
    await expect(trigger.getByTestId("seat-threads-button-unread")).toHaveText("2", { timeout: 30_000 });
    console.log("BUTTON", await shot(page, "1-button-unread"));

    // The popup opens on the newest thread and reads it: its row goes quiet, the other keeps its count.
    await trigger.click();
    await expect(page.getByTestId("seat-threads")).toBeVisible({ timeout: 20_000 });
    const rows = page.getByTestId("seat-threads-row");
    await expect(rows).toHaveCount(2, { timeout: 20_000 });
    await expect(rows.nth(0).getByTestId("seat-threads-row-unread")).toHaveCount(0, { timeout: 20_000 });
    await expect(rows.nth(1).getByTestId("seat-threads-row-unread")).toHaveText("1");
    await expect(trigger.getByTestId("seat-threads-button-unread")).toHaveText("1", { timeout: 20_000 });
    console.log("ROWS", await shot(page, "2-rows-one-read"));

    // The store agrees: one point for the thread that was shown, none for the other.
    const read = await page.evaluate(
      async ([canvasName, nodeId]) =>
        window.junto!.seatThreadReads({ canvasName, nodeId }),
      [CANVAS, "ada"] as const,
    );
    expect(Object.keys(read)).toHaveLength(1);
  } finally {
    await junto.close();
  }
});
