/**
 * Profiles in the real app: from the seat's selection panel give it a soul
 * and instructions, save it as a profile (a taken name asks before it
 * replaces), find it as a card in the add picker and under its Profiles tab,
 * build a second profile with Create profile without making a seat, and seat
 * the first again inside a region: a fresh seat with the same harness, face,
 * soul, and instructions. Both themes.
 * Screenshots land in test-results/profiles/ (never committed), or JUNTO_SHOTS_DIR.
 *
 * Run: `bunx electron-vite build && bun run test:e2e:fast e2e/scenarios/profiles.spec.ts`
 */
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const shots = process.env.JUNTO_SHOTS_DIR ?? "test-results/profiles";

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
  const saveDialog = page.getByRole("dialog", { name: "Save as profile" });

  for (const theme of ["Dark", "Bright"] as const) {
    await setTheme(page, theme);
    const tag = theme.toLowerCase();
    // Placing a profile frames the new seat; bring the whole board back.
    await page.getByRole("button", { name: "Fit all nodes" }).click();
    await stableBox(seat);

    // Select the seat: its panel carries the right-click menu's seat actions.
    const box = await stableBox(seat);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const panelGuidance = page.getByTestId("rts-seat-guidance");
    await expect(panelGuidance).toBeVisible();
    await expect(page.getByTestId("rts-save-profile")).toBeVisible();
    await page.screenshot({ path: `${shots}/${tag}-1-selection-panel.png` });
    await panelGuidance.click();
    const soul = page.getByTestId("agent-editor-soul");
    await expect(soul).toBeVisible();
    if (theme === "Dark") {
      await soul.fill("A careful reviewer. Speaks plainly, asks before guessing.");
      await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 5_000 });
      await page.getByRole("tab", { name: "instructions" }).click();
      await page.getByTestId("agent-editor-instructions").fill("Run the tests before you call a task done.");
    }
    await page.getByRole("tab", { name: "launch" }).click();
    const launchSave = page.getByTestId("agent-editor").getByRole("button", { name: "Save as profile" });
    await expect(launchSave).toBeVisible();

    // Save as profile: a plain name field; a taken name asks before replacing.
    await launchSave.click();
    await expect(saveDialog).toBeVisible();
    await page.waitForTimeout(400);
    const nameField = saveDialog.getByRole("textbox", { name: "Profile name" });
    await nameField.fill("Reviewer");
    await page.screenshot({ path: `${shots}/${tag}-2-save-dialog.png` });
    await saveDialog.getByRole("button", { name: "Save profile" }).click();
    if (theme === "Dark") {
      await expect(saveDialog).toHaveCount(0);
      // Again under the same name: asked inline, not saved.
      await page.getByTestId("rts-save-profile").click();
      await expect(saveDialog).toBeVisible();
      await saveDialog.getByRole("textbox", { name: "Profile name" }).fill("Reviewer");
      await saveDialog.getByRole("button", { name: "Save profile" }).click();
    }
    await expect(saveDialog.getByText("is already a profile")).toBeVisible();
    await expect(saveDialog.getByRole("button", { name: "Replace Reviewer" })).toBeVisible();
    await page.screenshot({ path: `${shots}/${tag}-3-replace-ask.png` });
    await saveDialog.getByRole("button", { name: "Back" }).click();
    await saveDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(saveDialog).toHaveCount(0);

    // The add picker inside the region: profile cards at catalog scale.
    const regionBox = await stableBox(region);
    // An empty spot in the region: the dark pass seats a profile where it clicks.
    const spot = theme === "Dark" ? { x: 0.15, y: 0.5 } : { x: 0.8, y: 0.3 };
    const openPicker = async () => {
      await page.mouse.click(regionBox.x + regionBox.width * spot.x, regionBox.y + regionBox.height * spot.y, { button: "right" });
      await expect(page.getByRole("button", { name: /^Place profile Reviewer/ })).toBeVisible();
    };
    await openPicker();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${shots}/${tag}-4-picker.png` });

    // The Profiles tab: only profiles, and Create profile.
    await page.getByRole("tab", { name: "Profiles" }).click();
    await expect(page.getByRole("region", { name: "Node catalog" })).toHaveCount(0);
    await page.screenshot({ path: `${shots}/${tag}-5-profiles-tab.png` });

    if (theme === "Dark") {
      // Create profile: the customize editor on a draft; no seat is made.
      const seatsBefore = await page.evaluate(async () => {
        const api = window.junto!;
        const { doc } = await api.readCanvas((await api.listCanvases())[0]!.name);
        return doc.nodes.length;
      });
      await page.getByRole("button", { name: "Create profile" }).click();
      const editor = page.getByTestId("agent-editor");
      await expect(editor).toBeVisible();
      await page.getByTestId("agent-editor-name").fill("Scout");
      await page.getByRole("tab", { name: "soul" }).click();
      await page.getByTestId("agent-editor-soul").fill("Curious. Maps the unknown before anyone builds on it.");
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${shots}/${tag}-6-create-profile.png` });
      await editor.getByRole("button", { name: "Save profile" }).click();
      await expect(editor).toHaveCount(0);
      await expect
        .poll(async () =>
          page.evaluate(async () => {
            const api = window.junto!;
            const { doc } = await api.readCanvas((await api.listCanvases())[0]!.name);
            const profiles = await api.profilesList();
            return {
              nodes: doc.nodes.length,
              scout: profiles.find((profile) => profile.name === "Scout")?.soul,
            };
          }))
        .toEqual({ nodes: seatsBefore, scout: "Curious. Maps the unknown before anyone builds on it." });
      await openPicker();
      await page.getByRole("tab", { name: "Profiles" }).click();
      await expect(page.getByRole("button", { name: /^Place profile Scout/ })).toBeVisible();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${shots}/${tag}-7-created.png` });
    } else {
      await page.getByRole("button", { name: "Create profile" }).click();
      const editor = page.getByTestId("agent-editor");
      await expect(editor).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${shots}/${tag}-6-create-profile.png` });
      await editor.getByRole("button", { name: "Discard" }).click();
      await expect(editor).toHaveCount(0);
      break;
    }

    // Seat Reviewer: a fresh seat inside the region with the soul and instructions.
    await page.getByRole("button", { name: /^Place profile Reviewer/ }).click();
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
    await page.screenshot({ path: `${shots}/${tag}-8-placed.png` });
    await page.keyboard.press("Escape");
  }
});
