/**
 * Multi-select → RTS chrome glue.
 *
 * Units cover classify / bulk color / multi-prompt fan-out. This only asserts
 * Shift-add selection surfaces the multi command card + multi-prompt input.
 * Run: `bunx electron-vite build && bun run test:e2e:fast e2e/scenarios/multi-select-rts.spec.ts`
 */
import { agentTextNode, canvasDoc, tasksNode } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const fixtureDoc = canvasDoc([
  tasksNode({ id: "tasks", x: 40, y: 40 }),
  agentTextNode({
    id: "seat-a",
    key: "local:alpha",
    label: "alpha",
    x: 320,
    y: 40,
  }),
  agentTextNode({
    id: "seat-b",
    key: "local:beta",
    label: "beta",
    x: 560,
    y: 40,
  }),
]);

const installBoard = async (page: import("@playwright/test").Page): Promise<void> => {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const runtime = globalThis as unknown as {
            readonly vellum?: { readonly listCanvases: () => Promise<unknown[]> };
          };
          return Boolean(runtime.vellum?.listCanvases);
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
  await page.evaluate(async (document) => {
    const api = (
      globalThis as unknown as {
        readonly vellum: {
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
    ).vellum;
    let list = await api.listCanvases();
    let name = list[0]?.name;
    if (!name) {
      const created = await api.createCanvas("multi");
      name = created.name;
    }
    const read = await api.readCanvas(name);
    await api.writeCanvas(name, document, read.revision);
  }, fixtureDoc);
};

test("shift multi-select: RTS multi command + multi-prompt", async ({ vellum }) => {
  const { page } = vellum;
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await installBoard(page);

  const alpha = page.locator(".react-flow__node", { hasText: "alpha" }).first();
  const beta = page.locator(".react-flow__node", { hasText: "beta" }).first();
  await expect(alpha).toBeVisible({ timeout: 30_000 });
  await expect(beta).toBeVisible({ timeout: 30_000 });

  await alpha.click();
  await expect(alpha).toHaveClass(/selected/);

  await beta.click({ modifiers: ["Shift"] });
  await expect(alpha).toHaveClass(/selected/);
  await expect(beta).toHaveClass(/selected/);

  const multiCmd = page.getByTestId("rts-multi-command");
  await expect(multiCmd).toBeVisible();
  await expect(multiCmd.locator(".rts-panel__label")).toContainText("command - multi");
  await expect(multiCmd.locator(".rts-cmd__meta")).toContainText("2 - agents");

  const multiPrompt = page.getByTestId("rts-multi-prompt");
  await expect(multiPrompt).toBeVisible();
  await expect(
    multiPrompt.getByRole("textbox", { name: "Prompt all selected agents" }),
  ).toBeVisible();

  // Mixed selection drops kind multi-prompt, keeps generic multi command.
  const tasks = page.locator(".react-flow__node", { hasText: "tasks" }).first();
  await tasks.click({ modifiers: ["Shift"] });
  await expect(page.getByTestId("rts-multi-command")).toBeVisible();
  await expect(page.getByTestId("rts-multi-prompt")).toHaveCount(0);
  await expect(page.locator(".rts-kind-surface .rts-quiet")).toContainText("mixed");
});
