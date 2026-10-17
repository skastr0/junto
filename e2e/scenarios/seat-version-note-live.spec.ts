/**
 * The unverified chip against the real inventory: this Mac's own harness
 * binaries are linked into the sandbox, so main's inventory scan reads their
 * real versions against each record's verified range (nothing is stood in).
 * Hermes is the exception: the harness's own fake answers for it. Frames land
 * in test-results/seat-version-note-live/.
 *   bun run test:e2e:fast e2e/scenarios/seat-version-note-live.spec.ts
 */
import { execFileSync } from "node:child_process";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { seededHarnessBinDir } from "../harness/agent-harness-fixture";
import { modelFixture, modelSeat } from "../harness/model";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "seat-version-note-live");
const CANVAS = "seat-version-note-live";

// harness id, binary, whether its record says this Mac reads as newer than verified.
const HARNESSES = [
  ["claude", "claude", false],
  ["codex", "codex", false],
  ["grok", "grok", true],
  ["muse", "muse", true],
  ["devin", "devin", true],
  ["cursor", "cursor-agent", true],
  ["agy", "agy", true],
  ["amp", "amp", true],
  ["fx", "fx", true],
] as const;

const nodes = HARNESSES.map(([harness], index) =>
  modelSeat({ id: harness, label: harness, harness, x: 40 + (index % 3) * 300, y: 40 + Math.floor(index / 3) * 200 }),
);

test("seats show the unverified chip from this Mac's real inventory", async () => {
  test.setTimeout(240_000);
  await mkdir(SHOTS, { recursive: true });
  const found = HARNESSES.map(([harness, binary, newer]) => {
    const path = execFileSync("/bin/sh", ["-c", `command -v ${binary} || true`], { encoding: "utf8" }).trim();
    return { harness, binary, newer, path };
  });
  const junto = await launchJunto({
    seedModels: { [CANVAS]: modelFixture(nodes, []) },
    afterSeed: async (sandbox) => {
      const bin = seededHarnessBinDir(sandbox);
      await mkdir(bin, { recursive: true });
      for (const { binary, path } of found) if (path) await symlink(path, join(bin, binary));
    },
  });
  try {
    const { page } = junto;
    const seat = (id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
    await expect(seat("claude")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /fit all/i }).first().click();

    // The first ask lands while the scan is still running; the card asks again every minute.
    const chip = (id: string) => seat(id).getByTestId("seat-version-note");
    const present = found.filter((row) => row.path);
    const readings = async () => {
      const out: Record<string, string> = {};
      for (const row of found) {
        if (!row.path) { out[row.harness] = "not installed on this Mac"; continue; }
        out[row.harness] = (await chip(row.harness).count()) === 0 ? "no chip" : (await chip(row.harness).locator(".sr-only").innerText()).trim() || "chip";
      }
      return out;
    };
    await expect(chip("grok")).toHaveCount(1, { timeout: 30_000 });
    console.log("first minute", JSON.stringify(await readings(), null, 1));
    await page.screenshot({ path: join(SHOTS, "first-minute.png") });

    await expect
      .poll(async () => Object.values(await readings()).every((text) => !text.startsWith("Version not read")), {
        timeout: 150_000,
        intervals: [3_000],
      })
      .toBe(true);
    console.log("settled", JSON.stringify(await readings(), null, 1));
    for (const row of present) {
      await expect(chip(row.harness)).toHaveCount(row.newer ? 1 : 0);
    }

    for (const theme of ["Dark", "Bright"] as const) {
      await page.getByRole("button", { name: "Open settings" }).click();
      await page.locator(".settings-nav__item", { hasText: "Appearance" }).click();
      const choice = page.getByRole("radiogroup", { name: "Theme", exact: true }).getByRole("radio", { name: new RegExp(theme) });
      await choice.click();
      await expect(choice).toHaveAttribute("aria-checked", "true");
      await page.locator(".settings-panel__close").click();
      await page.getByRole("button", { name: /fit all/i }).first().click();
      await page.waitForTimeout(1200);
      const first = present.find((row) => row.newer);
      if (first) await chip(first.harness).hover();
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(SHOTS, `${theme.toLowerCase()}.png`) });
      await page.mouse.move(4, 4);
    }
  } finally {
    await junto.close();
  }
});
