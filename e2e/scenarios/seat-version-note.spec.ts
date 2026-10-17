/**
 * A seat whose harness is newer than Junto was verified on says so, quietly,
 * at the end of its line; a verified one says nothing. The inventory is the
 * seat's own machine's, answered here by a stand-in for main's inventory
 * channel so the verdicts are fixed. Frames land in test-results/seat-version-note/.
 *   bun run test:e2e:fast e2e/scenarios/seat-version-note.spec.ts
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { modelFixture, modelSeat } from "../harness/model";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "seat-version-note");
const CANVAS = "seat-version-note";

const nodes = [
  modelSeat({ id: "newer", label: "scout", harness: "grok", x: 40, y: 40 }),
  modelSeat({ id: "verified", label: "builder", harness: "codex", x: 320, y: 40 }),
];

test("an unverified harness version shows a quiet chip; a verified one shows none", async () => {
  await mkdir(SHOTS, { recursive: true });
  const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture(nodes, []) } });
  try {
    const { page } = junto;
    const seat = (id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
    await expect(seat("newer")).toBeVisible({ timeout: 30_000 });

    await junto.app.evaluate(({ ipcMain }) => {
      const row = (harness: string, version: string, verdict: string, from: string, through: string) => ({
        harness, installed: true, version, models: [], efforts: [], refreshing: false,
        verification: { verdict, from, through },
      });
      ipcMain.removeHandler("junto:machine-inventory");
      ipcMain.handle("junto:machine-inventory", (_event, machine: string) => ({
        ok: true,
        inventory: {
          machine,
          harnesses: [
            { ...row("grok", "0.2.14", "newer", "0.1.0", "0.2.3"), machine },
            { ...row("codex", "0.46.0", "verified", "0.40.0", "0.50.0"), machine },
          ],
        },
      }));
    });
    // A fresh renderer asks the stand-in at once.
    await page.reload();
    await expect(seat("newer")).toBeVisible({ timeout: 30_000 });

    const note = seat("newer").getByTestId("seat-version-note");
    await expect(note).toBeVisible({ timeout: 10_000 });
    await expect(note).toHaveText(/unverified/i);
    await expect(note.locator(".sr-only")).toHaveText(
      "Newer than tested (verified through 0.2.3). This machine has 0.2.14. It still launches.",
    );
    await expect(seat("verified").getByTestId("seat-version-note")).toHaveCount(0);

    await page.locator(".react-flow__pane").click({ position: { x: 12, y: 12 } });
    await page.getByRole("button", { name: /fit all/i }).first().click();
    await page.waitForTimeout(1200);
    await page.mouse.move(8, 400);
    const boxes = await Promise.all([seat("newer").boundingBox(), seat("verified").boundingBox()]);
    const [a, b] = boxes;
    if (!a || !b) throw new Error("a seat has no box");
    const x = Math.min(a.x, b.x) - 24;
    const y = Math.min(a.y, b.y) - 24;
    await page.screenshot({
      path: join(SHOTS, "seats.png"),
      clip: { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x + 24, height: Math.max(a.y + a.height, b.y + b.height) - y + 24 },
    });
  } finally {
    await junto.close();
  }
});
