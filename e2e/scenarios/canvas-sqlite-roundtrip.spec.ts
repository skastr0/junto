import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  canvasDoc,
  taskItem,
  tasksNode,
  textNode,
} from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const ORIGINAL_TEXT = "roundtrip original";
const UI_EDITED_TEXT = "roundtrip edited via UI";
const IPC_ADDED_TEXT = "created through the product IPC";
const SEEDED_TASK_ID = "sqlite-seed-task";

test.use({
  vellumOptions: {
    seedCanvases: {
      roundtrip: canvasDoc([
        textNode("n1", ORIGINAL_TEXT, 0, 0),
        tasksNode({
          id: "seeded-work",
          x: 0,
          y: 200,
          items: [taskItem(SEEDED_TASK_ID, "seeded through WorkRepository")],
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
  readonly canvasesDir: string;
}): Promise<void> => {
  expect(
    await exists(join(input.homeDir, ".vellum", "state", "vellum.db")),
    "unified SQLite state database",
  ).toBe(true);

  const canvasEntries = await readdir(input.canvasesDir, {
    withFileTypes: true,
  });
  const unsupportedEntries = canvasEntries
    .filter(
      (entry) =>
        !entry.isFile() ||
        (!entry.name.endsWith(".digest.txt") && !entry.name.endsWith(".svg")),
    )
    .map((entry) => entry.name);
  expect(unsupportedEntries).toEqual([]);
};

test("operator UI write round-trips through main IPC and survives renderer reload", async ({
  vellum,
}) => {
  const { page, sandbox } = vellum;

  const node = page.locator(".react-flow__node", { hasText: ORIGINAL_TEXT });
  await expect(node).toBeVisible({ timeout: 30_000 });
  await node.click();
  await node.getByRole("button", { name: "Edit item" }).first().click();

  const textarea = page.getByLabel("Edit note");
  await expect(textarea).toBeVisible();
  await textarea.fill(UI_EDITED_TEXT);
  await textarea.blur();

  await expect
    .poll(
      () =>
        page.evaluate(async (name) => {
          const api = window.vellum;
          if (!api) throw new Error("Vellum Command preload bridge is unavailable");
          const result = await api.readCanvas(name);
          const written = result.doc.nodes.find(
            (candidate) => candidate.id === "n1",
          );
          return written?.type === "text" ? written.text : undefined;
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

test("canvas list/read/write product paths persist through the unified SQLite authority", async ({
  vellum,
}) => {
  const { page, sandbox } = vellum;

  const result = await page.evaluate(
    async ({ name, addedText }) => {
      const api = window.vellum;
      if (!api) throw new Error("Vellum Command preload bridge is unavailable");

      const before = await api.readCanvas(name);
      const next = {
        ...before.doc,
        nodes: [
          ...before.doc.nodes,
          {
            id: "n2",
            type: "text" as const,
            text: addedText,
            x: 400,
            y: 0,
            width: 240,
            height: 120,
          },
        ],
      };
      const write = await api.writeCanvas(name, next, before.revision);
      const [after, listed] = await Promise.all([
        api.readCanvas(name),
        api.listCanvases(),
      ]);
      const seededTask = after.doc.nodes
        .find((node) => node.id === "seeded-work")
        ?.ether?.tasks?.items.find((task) => task.id === "sqlite-seed-task");
      return {
        beforeRevision: before.revision,
        writeRevision: write.revision,
        afterRevision: after.revision,
        nodeTexts: after.doc.nodes.flatMap((node) =>
          node.type === "text" ? [node.text] : [],
        ),
        listedNames: listed.map((canvas) => canvas.name),
        seededTaskState: seededTask?.state,
      };
    },
    { name: "roundtrip", addedText: IPC_ADDED_TEXT },
  );

  expect(result.writeRevision).not.toBe(result.beforeRevision);
  expect(result.afterRevision).toBe(result.writeRevision);
  expect(result.nodeTexts).toContain(IPC_ADDED_TEXT);
  expect(result.listedNames).toContain("roundtrip");
  expect(result.seededTaskState).toBe("submitted");
  await expect(
    page.locator(".react-flow__node", { hasText: IPC_ADDED_TEXT }),
  ).toBeVisible({ timeout: 10_000 });

  await expectSqliteAuthority(sandbox);
});
