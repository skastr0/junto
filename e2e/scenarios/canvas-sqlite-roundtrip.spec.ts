import { commandModel, modelFixture, modelNote, modelSeat, readModelCanvas } from "../harness/model";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "../harness/launch";

const ORIGINAL_TEXT = "roundtrip original";
const UI_EDITED_TEXT = "roundtrip edited via UI";
const IPC_ADDED_TEXT = "created through the product IPC";

test.use({
  juntoOptions: {
    seedModels: {
      roundtrip: modelFixture([
        modelNote("n1", ORIGINAL_TEXT, 0, 0),
        modelSeat({
          id: "seeded-seat",
          key: "local:sqlite-seed-seat",
          label: "seeded seat",
          x: 0,
          y: 200,
        }),
      ]),
    },
  },
});

const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const expectSqliteAuthority = async (input: {
  readonly homeDir: string;
}): Promise<void> => {
  expect(
    await exists(join(input.homeDir, ".junto", "state", "junto.db")),
    "unified SQLite state database",
  ).toBe(true);

  expect(
    await exists(join(input.homeDir, ".junto", "canvases")),
    "no canvases directory is written",
  ).toBe(false);
};

test("operator UI write round-trips through main IPC and survives renderer reload", async ({
  junto,
}) => {
  const { page, sandbox } = junto;

  const node = page.locator(".react-flow__node", { hasText: ORIGINAL_TEXT });
  await expect(node).toBeVisible({ timeout: 30_000 });
  await node.click();
  // Cards carry no action buttons; free-note editing lives on the RTS kind
  // strip ("Edit note") and opens the note editor focus surface.
  await page.getByRole("button", { name: "Edit note" }).click();

  const textarea = page.getByLabel("Note markdown");
  await expect(textarea).toBeVisible();
  await textarea.fill(UI_EDITED_TEXT);
  await page.getByRole("button", { name: "done", exact: true }).click();

  await expect
    .poll(
      () =>
        page.evaluate(async (name) => {
          const api = window.junto;
          if (!api) throw new Error("Junto preload bridge is unavailable");
          const result = await api.modelOpen({ canvas: name });
          const written = result.nodes.find(
            (candidate) => candidate.id === "n1",
          );
          return written?.kind === "note" ? written.text : undefined;
        }, "roundtrip"),
      { timeout: 10_000 },
    )
    .toBe(UI_EDITED_TEXT);

  await page.reload();
  await expect(
    page.locator(".react-flow__node", { hasText: UI_EDITED_TEXT }),
  ).toBeVisible({ timeout: 30_000 });

  await expectSqliteAuthority(sandbox);
});

test("model list/open/command product paths persist through the unified SQLite authority", async ({
  junto,
}) => {
  const { page, sandbox } = junto;

  const before = await readModelCanvas(page, "roundtrip");
  const written = await commandModel(page, { _tag: "Add", canvas: "roundtrip", nodes: [{ ...modelNote("n2", IPC_ADDED_TEXT, 400, 0), z: 2 }], wires: [] });
  const after = await readModelCanvas(page, "roundtrip");
  const listed = await page.evaluate(() => window.junto!.modelCanvases());
  expect(written.seq).toBeGreaterThan(before.seq);
  expect(after.seq).toBe(written.seq);
  expect(after.nodes.filter((node) => node.kind === "note").map((node) => node.text)).toContain(IPC_ADDED_TEXT);
  expect(listed.map((canvas) => canvas.name)).toContain("roundtrip");
  expect(after.nodes.find((node) => node.id === "seeded-seat")?.kind).toBe("agent");
  await expect(
    page.locator(".react-flow__node", { hasText: IPC_ADDED_TEXT }),
  ).toBeVisible({ timeout: 10_000 });

  await expectSqliteAuthority(sandbox);
});
