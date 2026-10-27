/**
 * 0.11 artifact links, L4, in the real app: an artifact's rail lists what
 * links to it, newest first: another artifact whose text links it, with the
 * line the link sits in, and a comment that mentions it. The body row opens
 * the linking artifact. Shots in both themes.
 *   bun run test:e2e:fast e2e/scenarios/artifacts-linked-from.spec.ts
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { mentionHref, mentionLink } from "../../src/shared/mention";
import { asNodeId, Node } from "../../src/shared/model";
import { mintItemId, mintOpId, type ItemId } from "../../src/shared/resource-command";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture } from "../harness/model";

const CANVAS = "linked-from";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/artifacts-linked-from";
const shelf = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })({
  kind: "artifacts",
  id: "shelf",
  label: "Shelf",
  x: 420,
  y: 60,
  width: 280,
  height: 160,
  z: 0,
});

test("an artifact lists the artifacts whose text links it and the comments that mention it, dark and bright", async () => {
  test.setTimeout(240_000);
  const junto = await launchJunto({ windowContentSize: { width: 1500, height: 900 }, seedModels: { [CANVAS]: modelFixture([shelf]) } });
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="shelf"]')).toBeVisible({ timeout: 30_000 });
    const node = asNodeId("shelf");
    const pricingId = mintItemId();
    const planId = mintItemId();
    const notesId = mintItemId();
    const create = (artifactId: ItemId, title: string, markdown: string) =>
      page.evaluate(
        ({ canvas, node, artifactId, opId, title, markdown }) =>
          window.junto!.resource!.artifact!.apply(canvas, node, artifactId, opId, { op: "create", title, body: { type: "document", markdown } }),
        { canvas: CANVAS, node, artifactId, opId: mintOpId(), title, markdown },
      );
    const pricing = mentionHref({ kind: "artifact", nodeId: node, artifactId: pricingId }, CANVAS);
    expect((await create(pricingId, "Pricing pages", "Superset Pro is $16 to $20 a user per month.")).kind).toBe("applied");
    expect((await create(notesId, "Research notes", "Competitors, in no order.")).kind).toBe("applied");
    expect(
      (
        await create(
          planId,
          "Launch plan",
          ["# Launch plan", "", `Numbers come from ${mentionLink({ kind: "artifact", nodeId: node, artifactId: pricingId }, "[[Pricing pages]]", CANVAS)} before we set the tiers.`].join("\n"),
        )
      ).kind,
    ).toBe("applied");
    // A comment on the notes that mentions the pricing page.
    const posted = await page.evaluate(
      ({ canvas, node, artifactId, opId, text }) =>
        window.junto!.resource!.thread!.post(canvas, { kind: "artifact", nodeId: node, artifactId }, { opId, text }),
      { canvas: CANVAS, node, artifactId: notesId, opId: mintOpId(), text: `Check these against [Pricing pages](${pricing}).` },
    );
    expect(posted.kind).toBe("applied");

    await page.locator('.react-flow__node[data-id="shelf"]').dblclick();
    const list = page.getByRole("list", { name: "Artifacts" });
    await expect(list).toBeVisible({ timeout: 20_000 });
    await list.locator("button").filter({ hasText: "Pricing pages" }).first().click();
    const edge = page.locator(".artifact-comments-edge");
    if ((await edge.count()) > 0) await edge.click();
    const panel = page.getByTestId("linked-from");
    await expect(panel).toBeVisible({ timeout: 15_000 });
    const rows = panel.getByTestId("linked-from-row");
    await expect(rows).toHaveCount(2, { timeout: 15_000 });
    await expect(panel).toContainText("Linked from, 2");
    await expect(rows.nth(0)).toHaveAttribute("data-kind", "post");
    await expect(rows.nth(1)).toHaveAttribute("data-kind", "body");
    // A comment's place is the artifact it is on, by its title.
    await expect(rows.nth(0).locator(".resource-chip__label")).toHaveText("Research notes");
    await expect(rows.nth(0)).toContainText("comment by you");
    await expect(rows.nth(1).locator(".linked-from__line")).toHaveText("Numbers come from [[Pricing pages]] before we set the tiers.");

    for (const theme of ["dark", "bright"] as const) {
      await page.evaluate((next) => window.junto!.settingsPatch({ appearance: { theme: next } }), theme);
      if (theme === "bright") await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
      else await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");
      mkdirSync(SHOTS, { recursive: true });
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(SHOTS, `linked-from-${theme}.png`) });
      await panel.screenshot({ path: join(SHOTS, `linked-from-panel-${theme}.png`) });
    }

    // The body row opens the artifact whose text holds the link.
    await rows.nth(1).getByRole("button").first().click();
    await expect(page.locator(".artifact-head__title")).toHaveValue("Launch plan", { timeout: 15_000 });
  } finally {
    await junto.close();
  }
});
