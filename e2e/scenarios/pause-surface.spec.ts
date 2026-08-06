/**
 * Canvas pause surface e2e.
 *
 * The factory is born paused (@shared/pause law). This drives the rendered
 * top bar: a fresh canvas must show the PAUSED state, the first play must
 * surface the explicit confirmation (honest consequences), and confirming
 * must flip the control to playing.
 *
 * Boards install at runtime via window.vellumCommand (disk seedCanvases is dead —
 * authority-only boot); pattern copied from work-plane.spec.ts.
 * Run: `bunx electron-vite build && bun run test:e2e:fast e2e/scenarios/pause-surface.spec.ts`
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { agentTextNode, canvasDoc, tasksNode } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "pause-surface");

const fixtureDoc = canvasDoc([
  tasksNode({ id: "tasks", x: 40, y: 40 }),
  agentTextNode({
    id: "seat",
    key: "local:worker",
    label: "worker",
    x: 320,
    y: 40,
  }),
]);

/** Authority-only boot: disk seed is not live. Install via writeCanvas. */
const installBoard = async (page: import("@playwright/test").Page): Promise<string> => {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const runtime = globalThis as unknown as {
            readonly vellumCommand?: { readonly listCanvases: () => Promise<unknown[]> };
          };
          return Boolean(runtime.vellumCommand?.listCanvases);
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
  return page.evaluate(async (document) => {
    const api = (
      globalThis as unknown as {
        readonly vellumCommand: {
          readonly listCanvases: () => Promise<ReadonlyArray<{ name: string }>>;
          readonly createCanvas: (name: string) => Promise<{ name: string; revision: string }>;
          readonly readCanvas: (name: string) => Promise<{ name: string; revision: string }>;
          readonly writeCanvas: (
            name: string,
            doc: unknown,
            expectedRevision?: string,
          ) => Promise<unknown>;
        };
      }
    ).vellumCommand;
    let list = await api.listCanvases();
    let name = list[0]?.name;
    if (!name) {
      const created = await api.createCanvas("pause");
      name = created.name;
    }
    const read = await api.readCanvas(name);
    await api.writeCanvas(name, document, read.revision);
    return name;
  }, fixtureDoc);
};

test("pause surface: born paused in top bar, first play confirms, confirm flips to playing", async ({
  vellum,
}) => {
  const { page } = vellum;
  await mkdir(SHOTS, { recursive: true });

  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await installBoard(page);
  await expect(page.locator(".react-flow__node", { hasText: "tasks" })).toBeVisible({
    timeout: 30_000,
  });

  // Born paused: the control shows the prominent paused state, no play yet.
  const control = page.getByTestId("factory-pause");
  await expect(control).toBeVisible({ timeout: 30_000 });
  await expect(control).toHaveAttribute("data-pause-state", "paused");
  await expect(control).toContainText(/paused/i);
  await page.screenshot({ path: join(SHOTS, "01-born-paused.png"), fullPage: false });

  // First play surfaces the explicit confirmation with honest consequences.
  await control.click();
  const confirm = page.getByTestId("first-play-confirm");
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("Play the factory");
  await expect(confirm).toContainText("Timers and watchers");
  await expect(confirm).toContainText("Vellum Command CLI");
  await expect(confirm).toContainText("Queued messages will deliver");
  await expect(confirm).toContainText("claim tick");
  await page.screenshot({ path: join(SHOTS, "02-first-play-confirm.png"), fullPage: false });

  // Cancel changes nothing.
  await confirm.getByRole("button", { name: /cancel/i }).click();
  await expect(confirm).not.toBeVisible();
  await expect(control).toHaveAttribute("data-pause-state", "paused");

  // Confirming flips the switch to playing (quiet state).
  await control.click();
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: /play/i }).click();
  await expect(confirm).not.toBeVisible();
  await expect(control).toHaveAttribute("data-pause-state", "playing");
  await expect(control).toContainText(/playing/i);
  await page.screenshot({ path: join(SHOTS, "03-playing.png"), fullPage: false });

  // Subsequent toggles are direct: pausing is instant, no dialog; and the
  // everPlayed latch makes the next play direct too.
  await control.click();
  await expect(control).toHaveAttribute("data-pause-state", "paused");
  await expect(page.getByTestId("first-play-confirm")).not.toBeVisible();
  await control.click();
  await expect(control).toHaveAttribute("data-pause-state", "playing");
  await expect(page.getByTestId("first-play-confirm")).not.toBeVisible();
});
