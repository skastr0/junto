/**
 * Every node kind is renamed from the RTS selection card (1b2c3318f, eb7ea0f37,
 * 170c9a988): Rename key, type, Enter; Escape keeps the old name; focus returns
 * to the Rename key; a peer and a stub show no key.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/rts-rename-kinds.spec.ts
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import type { Page } from "@playwright/test";
import { Node } from "../../src/shared/model";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelRegion, modelSeat, readModelNode } from "../harness/model";

const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/rts-rename-kinds";
const CANVAS = "verify-rename";
const decode = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" });
const at = (x: number, y: number, width = 240, height = 96) => ({ x, y, width, height, z: 0 });

const nodes = [
  modelSeat({ id: "seat", label: "worker", x: 40, y: 40 }),
  decode({ kind: "task", id: "task", name: "Ship", ...at(320, 40) }),
  decode({ kind: "note", id: "note", text: "# Field notes\nsecond line stays", ...at(600, 40) }),
  decode({ kind: "page", id: "page", url: "https://example.com/", profile: "personal", onRemove: "kill-session", ...at(880, 40) }),
  decode({ kind: "link", id: "link", url: "https://example.org/docs", ...at(40, 200) }),
  decode({ kind: "file", id: "file", path: "/tmp/verify-rename-notes.txt", ...at(320, 200) }),
  decode({ kind: "peer", id: "remote", label: "reviewer", host: "macbook", seatId: `seat_${"a".repeat(64)}`, ...at(600, 200) }),
  decode({ kind: "stub", id: "stub-git", of: "git", label: "other repo", ...at(880, 200) }),
  modelRegion({ id: "region-ops", label: "ops", x: 40, y: 340, width: 520, height: 180 }),
];

const shot = async (page: Page, name: string): Promise<void> => {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

type Case = { id: string; kind: string; field: string; next: string; read: (n: Record<string, unknown>) => unknown; before: unknown };

const cases: Case[] = [
  { id: "seat", kind: "seat", field: "Agent name", next: "renamed worker", read: (n) => n.label, before: "worker" },
  { id: "task", kind: "task", field: "Task name", next: "Shipping board", read: (n) => n.name, before: "Ship" },
  { id: "note", kind: "note", field: "Note name", next: "Renamed heading", read: (n) => String(n.text).split("\n")[0], before: "# Field notes" },
  { id: "page", kind: "page", field: "Page name", next: "Example page", read: (n) => n.label, before: undefined },
  { id: "link", kind: "link", field: "Link name", next: "Docs link", read: (n) => n.label, before: undefined },
  { id: "file", kind: "file", field: "File name", next: "Notes file", read: (n) => n.label, before: undefined },
];

test("every kind renames from the selection card; peer and stub show no key", async () => {
  test.setTimeout(300_000);
  const junto = await launchJunto({ windowContentSize: { width: 1320, height: 900 }, seedModels: { [CANVAS]: modelFixture(nodes, []) } });
  try {
    const { page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.react-flow__node[data-id="seat"]')).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Fit all" }).click();
    await page.waitForTimeout(800);
    const card = page.locator(".rts-panel--cmd");
    const renameKey = card.getByRole("button", { name: "Rename" });
    const focusOnRenameKey = (): Promise<boolean> =>
      page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Rename");
    const modelOf = async (id: string) => (await readModelNode(page, CANVAS, id)) as unknown as Record<string, unknown>;
    const report: string[] = [];
    const failures: string[] = [];

    const select = async (id: string): Promise<void> => {
      const box = (await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox())!;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect(card).toBeVisible();
    };

    for (const c of cases) {
      await select(c.id);
      await expect(renameKey, `${c.kind}: exactly one Rename key`).toHaveCount(1);
      const titleBefore = (await card.locator(".rts-cmd__title").innerText()).trim();

      // Escape keeps the old name, and focus returns to the Rename key.
      await renameKey.click();
      const field = page.getByRole("textbox", { name: c.field });
      await expect(field, `${c.kind}: field "${c.field}" opens`).toBeVisible();
      await field.fill("scrap this");
      await field.press("Escape");
      await expect(field).toBeHidden();
      await expect.poll(focusOnRenameKey, { message: `${c.kind}: focus back on Rename after Escape` }).toBe(true);
      expect((await card.locator(".rts-cmd__title").innerText()).trim(), `${c.kind}: Escape keeps the old title`).toBe(titleBefore);
      expect(c.read(await modelOf(c.id)), `${c.kind}: Escape leaves the model alone`).toEqual(c.before);

      // Type and Enter renames.
      await renameKey.click();
      await expect(field).toBeVisible();
      await field.fill(c.next);
      await shot(page, `${c.kind}-field-open`);
      await field.press("Enter");
      await expect(field).toBeHidden();
      await expect.poll(focusOnRenameKey, { message: `${c.kind}: focus back on Rename after Enter` }).toBe(true);
      const want = c.kind === "note" ? `# ${c.next}` : c.next;
      let got: unknown;
      for (let t = 0; t < 40; t += 1) {
        got = c.read(await modelOf(c.id));
        if (got === want) break;
        await page.waitForTimeout(250);
      }
      if (got !== want) {
        failures.push(`${c.kind}: model reads ${JSON.stringify(got)} after Enter, wanted ${JSON.stringify(want)}; node=${JSON.stringify(await modelOf(c.id))}; card title now "${(await card.locator(".rts-cmd__title").innerText()).trim()}"`);
        await shot(page, `${c.kind}-NOT-RENAMED`);
        continue;
      }
      const titleAfter = (await card.locator(".rts-cmd__title").innerText()).trim();
      await shot(page, `${c.kind}-renamed`);
      report.push(`${c.kind} | title "${titleBefore}" -> "${titleAfter}" | model ${JSON.stringify(c.read(await modelOf(c.id)))} | focus on Rename key`);
    }
    // The note's second line is untouched.
    expect(String((await modelOf("note")).text)).toContain("second line stays");

    // Region: through its drag handle.
    await page.locator(".region-drag-handle", { hasText: "ops" }).first().click();
    await expect(card).toBeVisible();
    await expect(renameKey).toHaveCount(1);
    await renameKey.click();
    const regionField = page.getByRole("textbox", { name: "Region name" });
    await expect(regionField).toBeVisible();
    await regionField.fill("scrap");
    await regionField.press("Escape");
    await expect(regionField).toBeHidden();
    await expect.poll(focusOnRenameKey).toBe(true);
    expect(((await modelOf("region-ops")) as { label?: string }).label, "region: Escape keeps old").toBe("ops");
    await renameKey.click();
    await regionField.fill("operations");
    await shot(page, "region-field-open");
    await regionField.press("Enter");
    await expect(regionField).toBeHidden();
    await expect.poll(focusOnRenameKey).toBe(true);
    await expect.poll(async () => ((await modelOf("region-ops")) as { label?: string }).label, { timeout: 10_000 }).toBe("operations");
    await shot(page, "region-renamed");
    report.push(`region | "ops" -> "operations" | focus on Rename key`);

    // Peer and stub: the card shows, with no Rename key.
    for (const id of ["remote", "stub-git"]) {
      await select(id);
      await expect(renameKey, `${id}: no Rename key`).toHaveCount(0);
      await shot(page, `${id}-no-key`);
      report.push(`${id} | selection card shown, Rename keys: ${await renameKey.count()}`);
    }
    console.log("REPORT\n" + report.join("\n"));
    console.log("FAILURES\n" + failures.join("\n"));
    expect(failures).toEqual([]);
  } finally {
    await junto.close();
  }
});
