import { modelFixture, modelNote, modelSeat } from "../harness/model";
import { expect, test } from "../harness/launch";

const ORIGINAL_TEXT = "roundtrip original";
const UI_EDITED_TEXT = "roundtrip edited via UI";

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

test("operator UI write round-trips through main IPC and survives renderer reload", async ({
  junto,
}) => {
  const { page } = junto;

  const node = page.locator(".react-flow__node", { hasText: ORIGINAL_TEXT });
  await expect(node).toBeVisible({ timeout: 30_000 });
  await node.click();
  // Cards carry no action buttons; free-note editing lives on the RTS kind
  // strip ("Edit note") and opens the note editor focus surface.
  // The key, not the card body: 52dd80875 names the body "Edit note, <title>".
  await page.getByRole("button", { name: "Edit note", exact: true }).click();

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
});
