/**
 * Profiles in the real app: give a seat a soul and instructions in the agent
 * editor, save it as a profile from its right-click menu, find the profile in
 * the add picker, and seat it again inside a region: a fresh seat with the
 * same harness, face, soul, and instructions. Both themes.
 * Screenshots land in test-results/profiles/ (never committed).
 *
 * Run: `bunx electron-vite build && bun run test:e2e:fast e2e/scenarios/profiles.spec.ts`
 */
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const shots = "test-results/profiles";

const fixtureDoc = canvasDoc([
  agentTextNode({ id: "seat-ada", key: "local:ada", label: "Ada", x: 0, y: 0 }),
  {
    id: "rg-lab",
    type: "group",
    label: "lab",
    x: 700,
    y: -80,
    width: 760,
    height: 480,
    ether: { region: { defaults: { paths: { local: "/tmp" } } } },
  },
]);

const installBoard = async (page: import("@playwright/test").Page): Promise<void> => {
  await expect
    .poll(
      async () =>
        page.evaluate(() => Boolean((globalThis as { junto?: { listCanvases?: unknown } }).junto?.listCanvases)),
      { timeout: 30_000 },
    )
    .toBe(true);
  await page.evaluate(async (document) => {
    const api = window.junto!;
    let name = (await api.listCanvases())[0]?.name;
    if (!name) name = (await api.createCanvas("profiles")).name;
    const read = await api.readCanvas(name);
    await api.writeCanvas(name, document, read.revision);
  }, fixtureDoc);
};

/** A node's box once it has stopped moving (the camera settles after load). */
const stableBox = async (locator: import("@playwright/test").Locator) => {
  let previous: { x: number; y: number; width: number; height: number } | null = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const box = await locator.boundingBox();
    if (box && previous && Math.abs(box.x - previous.x) < 0.5 && Math.abs(box.y - previous.y) < 0.5) return box;
    previous = box;
    await locator.page().waitForTimeout(250);
  }
  if (!previous) throw new Error("node never laid out");
  return previous;
};

const setTheme = async (page: import("@playwright/test").Page, theme: "Dark" | "Bright") => {
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.locator(".settings-nav__item", { hasText: "Appearance" }).click();
  await page.getByRole("radio", { name: theme }).click();
  await page.locator(".settings-panel__close").click();
  await page.waitForTimeout(300);
};

test("profiles: soul and instructions, save as profile, seat it again", async ({ junto }) => {
  const { page } = junto;
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await installBoard(page);
  const seat = page.locator('.react-flow__node[data-id="seat-ada"]');
  const region = page.locator('.react-flow__node[data-id="rg-lab"]');
  await expect(seat).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Fit all nodes" }).click();
  await stableBox(region);

  for (const theme of ["Dark", "Bright"] as const) {
    await setTheme(page, theme);
    const tag = theme.toLowerCase();
    // Placing a profile frames the new seat; bring the whole board back.
    await page.getByRole("button", { name: "Fit all nodes" }).click();
    await stableBox(seat);

    // Right-click the seat: soul and instructions open the editor there.
    const box = await stableBox(seat);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
    await expect(page.getByTestId("seat-menu")).toBeVisible();
    await page.screenshot({ path: `${shots}/${tag}-1-seat-menu.png` });
    await page.getByRole("button", { name: "Edit soul and instructions" }).click();
    const soul = page.getByTestId("agent-editor-soul");
    await expect(soul).toBeVisible();
    if (theme === "Dark") {
      await soul.fill("A careful reviewer. Speaks plainly, asks before guessing.");
      await expect(page.getByText("Saved")).toBeVisible({ timeout: 5_000 });
    }
    await page.screenshot({ path: `${shots}/${tag}-2-soul.png` });
    await page.getByRole("tab", { name: "instructions" }).click();
    const instructions = page.getByTestId("agent-editor-instructions");
    if (theme === "Dark") {
      await instructions.fill("Run the tests before you call a task done.");
      await page.getByRole("tab", { name: "launch" }).click();
    } else {
      await page.getByRole("tab", { name: "launch" }).click();
    }
    await expect(page.getByRole("button", { name: "Save as profile" })).toBeVisible();
    await page.screenshot({ path: `${shots}/${tag}-3-launch.png` });

    // Save as profile from the Launch section.
    await page.getByRole("button", { name: "Save as profile" }).click();
    const dialog = page.getByRole("dialog", { name: "Save as profile" });
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(400);
    if (theme === "Dark") {
      await dialog.getByRole("combobox", { name: "Profile name" }).fill("Reviewer");
      await page.screenshot({ path: `${shots}/${tag}-4-save-dialog.png` });
      await dialog.getByRole("button", { name: "Save profile" }).click();
      await expect(dialog).toHaveCount(0);
    } else {
      await dialog.getByRole("combobox", { name: "Profile name" }).fill("Reviewer");
      await page.screenshot({ path: `${shots}/${tag}-4-save-dialog.png` });
      await dialog.getByRole("button", { name: "Cancel" }).click();
    }

    // The add picker inside the region shows the profile.
    const regionBox = await stableBox(region);
    // An empty spot in the region: the dark pass seats a profile where it clicks.
    const spot = theme === "Dark" ? { x: 0.15, y: 0.5 } : { x: 0.8, y: 0.3 };
    await page.mouse.click(regionBox.x + regionBox.width * spot.x, regionBox.y + regionBox.height * spot.y, { button: "right" });
    const tile = page.getByRole("button", { name: /^Place profile Reviewer/ });
    await expect(tile).toBeVisible();
    await page.screenshot({ path: `${shots}/${tag}-5-picker.png` });
    if (theme === "Bright") {
      await page.keyboard.press("Escape");
      break;
    }

    // Seat it: a fresh seat inside the region with the soul and instructions.
    await tile.click();
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const api = window.junto!;
          const name = (await api.listCanvases())[0]!.name;
          const { doc } = await api.readCanvas(name);
          const fresh = doc.nodes.filter((node) => node.ether?.entity?.kind === "agent" && node.id !== "seat-ada");
          const guidance = await api.seatGuidanceList();
          return fresh.map((node) => ({
            label: node.ether?.terminal?.label,
            harness: node.ether?.terminal?.harness,
            cwd: node.ether?.terminal?.launch?.cwd,
            guidance: guidance[node.id],
          }));
        }), { timeout: 15_000 })
      .toEqual([
        {
          label: "Reviewer",
          harness: "codex",
          cwd: "/tmp",
          guidance: {
            soul: "A careful reviewer. Speaks plainly, asks before guessing.",
            instructions: "Run the tests before you call a task done.",
          },
        },
      ]);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${shots}/${tag}-6-placed.png` });
    await page.keyboard.press("Escape");
  }
});
