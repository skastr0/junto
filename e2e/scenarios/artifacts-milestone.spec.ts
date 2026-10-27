/**
 * The 0.10 Artifacts milestone, driven in the real app: each type made, an
 * edit that lands a new version, history, a stale edit refused, an operator
 * comment with a seat mention that survives a reload, a seat's CLI comment
 * from a throwaway folder that shows in the rail, archive and restore.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/artifacts-milestone.spec.ts
 * The seat's CLI is dist/junto (seat-env.ts injects JUNTO_CLI from it).
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Schema } from "effect";
import { ArtifactVersion } from "../../src/shared/artifact";
import { asNodeId, Node } from "../../src/shared/model";
import { mintOpId } from "../../src/shared/resource-command";
import { ItemId } from "../../src/shared/work-ids";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness, type CrewCliResult } from "../harness/crew-fixture";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelRegion, modelSeat } from "../harness/model";

const CANVAS = "artifacts-milestone";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/artifacts-milestone";

const shot = async (page: Page, name: string): Promise<void> => {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

/** The CLI's JSON envelope, whatever it printed around it. */
const envelope = (result: CrewCliResult): { ok?: boolean; data?: unknown; error?: { type?: string; message?: string } } => {
  const text = result.stdout.trim() || result.stderr.trim();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: { message: `${result.stdout}${result.stderr}` } };
  }
};

test("artifacts: each type, a new version, history, a stale edit refused, comments that last, archive and restore", async () => {
  test.setTimeout(420_000);
  const folder = mkdtempSync(join(tmpdir(), "junto-artifacts-seat-"));
  const scout = modelSeat({ id: "scout", key: "local:am-scout", label: "Scout", harness: "codex", cwd: folder, x: 40, y: 60 });
  const shelf = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })({ kind: "artifacts", id: "shelf", label: "Shelf", x: 400, y: 60, width: 280, height: 160, z: 0 });
  const ops = modelRegion({ id: "ops", label: "Ops", x: 0, y: 0, width: 800, height: 400 });
  const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture([ops, scout, shelf], []) }, afterSeed: installCrewSeatHarness });
  try {
    const { page, sandbox } = junto;
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "bright" } }));
    await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
    const card = page.locator('.react-flow__node[data-id="shelf"]');
    await expect(card).toBeVisible({ timeout: 30_000 });

    const seat = crewSeat(sandbox, CANVAS, "scout");
    await crewPlayFactory(page);
    await crewOccupySeat(page, CANVAS, scout, seat);
    expect((await seat.op("onboard", {})).ok, "scout onboards").toBe(true);
    const cli = async (argv: ReadonlyArray<string>) => {
      const result = await seat.cli(["artifact", ...argv]);
      const env = envelope(result);
      console.log(`CLI artifact ${argv.join(" ")} ->`, JSON.stringify(env).slice(0, 600));
      return env;
    };

    const open = async (): Promise<void> => {
      await card.dblclick();
      await expect(page.getByRole("list", { name: "Artifacts" })).toBeVisible({ timeout: 20_000 });
    };
    const list = () => page.getByRole("list", { name: "Artifacts" });
    const pick = async (title: string): Promise<void> => {
      await list().locator("button").filter({ hasText: title }).first().click();
      await expect(page.locator(".artifact-head__title")).toHaveValue(title);
    };
    const meta = page.locator(".artifact-head__meta");
    /** The comments rail starts as its edge; pressing the edge opens it. */
    const edge = page.locator(".artifact-comments-edge");
    const openRail = async (): Promise<void> => {
      await edge.click();
      await expect(page.getByLabel("New comment")).toBeVisible();
    };

    await open();
    await shot(page, "01-empty");

    // Create each type the operator makes from nothing.
    for (const noun of ["Document", "Sheet", "Pad"]) {
      await page.getByRole("button", { name: "New artifact" }).click();
      await page.getByRole("group", { name: "New artifact" }).locator("button").filter({ hasText: noun }).click();
      await expect(meta).toHaveText(`${noun}, version 1`, { timeout: 15_000 });
      await shot(page, `02-created-${noun.toLowerCase()}`);
    }
    await page.getByRole("button", { name: "New artifact" }).click();
    await page.getByRole("group", { name: "New artifact" }).locator("button").filter({ hasText: "Link" }).click();
    const linkForm = page.getByRole("form", { name: "New link" });
    await linkForm.getByLabel("URL").fill("https://example.com/release");
    await linkForm.getByLabel("Title").fill("Release page");
    await linkForm.getByRole("button", { name: "Add link" }).click();
    await expect(meta).toHaveText("Link, version 1", { timeout: 15_000 });
    await shot(page, "02-created-link");

    // A file arrives from the CLI: the seat makes it.
    await createFile(seat, cli);
    await expect(list().locator("button").filter({ hasText: "Release build log" })).toBeVisible({ timeout: 20_000 });
    await pick("Release build log");
    await shot(page, "02-created-file");

    // Edit the document: a new version.
    await pick("Untitled document");
    const markdown = page.getByLabel("Markdown");
    await markdown.fill("# Release notes\n\nFirst draft of the 0.10 notes.");
    await markdown.blur();
    await expect(meta).toHaveText("Document, version 2", { timeout: 15_000 });
    await shot(page, "03-edited-version-2");

    // History: both versions, the first readable.
    await page.getByRole("button", { name: "History" }).click();
    const versions = page.getByRole("list", { name: "Versions" });
    await expect(versions.locator("button")).toHaveCount(2, { timeout: 15_000 });
    await versions.locator("button").filter({ hasText: "Version 1" }).click();
    await expect(page.getByRole("button", { name: /Restore as version 3/ })).toBeEnabled();
    await shot(page, "04-history");
    await page.getByRole("button", { name: "Back to editing" }).first().click();

    // The document's id, as the seat lists it.
    const listed = await cli(["list", "--type", "document"]);
    expect(listed.ok, JSON.stringify(listed)).toBe(true);
    const docId = Schema.decodeUnknownSync(ItemId)(findId(listed.data, "Untitled document"));

    // A stale edit is refused: the operator types while another write lands on the head.
    await markdown.fill("# Release notes\n\nFirst draft of the 0.10 notes.\n\nOperator line typed on version 2.");
    const landed = await page.evaluate(
      ({ canvas, node, artifactId, baseVersion, opId }) =>
        window.junto!.resource!.artifact!.apply(canvas, node, artifactId, opId, {
          op: "edit",
          edit: { kind: "replace", baseVersion, body: { type: "document", markdown: "# Release notes\n\nSeat rewrote this on version 2." } },
        }),
      { canvas: CANVAS, node: asNodeId("shelf"), artifactId: docId, baseVersion: ArtifactVersion.make(2), opId: mintOpId() },
    );
    console.log("OTHER WRITE:", JSON.stringify(landed).slice(0, 300));
    const refusal = page.locator(".artifact-document__refusal");
    await expect(refusal).toBeVisible({ timeout: 15_000 });
    console.log("STALE REFUSAL (app):", await refusal.innerText());
    await shot(page, "05-stale-refused");
    await refusal.getByRole("button", { name: "Take theirs" }).click();
    await expect(meta).toHaveText("Document, version 3");
    const staleCli = await cli(["edit", docId, "--base", "1", "--markdown", "# from a stale base"]);
    expect(staleCli.ok, "the CLI's stale edit is refused").toBe(false);

    // The rail is collapsed to its edge: no comments yet, so no count and no faces.
    await expect(edge).toBeVisible();
    await expect(page.getByTestId("comments-edge-count")).toHaveCount(0);
    await expect(page.getByTestId("comments-edge-seat")).toHaveCount(0);
    await openRail();

    // An operator comment with a seat mention.
    const field = page.getByLabel("New comment");
    await field.click();
    await field.pressSequentially("Notes read right, over to @");
    const options = page.getByTestId("mention-option");
    await expect(options.filter({ hasText: "Scout" })).toBeVisible({ timeout: 10_000 });
    await shot(page, "06-at-options");
    await options.filter({ hasText: "Scout" }).click();
    await field.pressSequentially(" for the merge");
    await page.locator(".artifact-comments").getByRole("button", { name: "Comment", exact: true }).first().click();
    const threads = page.getByRole("list", { name: "Threads" });
    await expect(threads.locator(".artifact-thread__post")).toHaveCount(1, { timeout: 20_000 });
    console.log("OPERATOR POST:", await threads.locator(".artifact-thread__post").first().innerText());
    await shot(page, "07-comment-mention-chip");

    // It survives a reload of the window.
    await page.reload();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await open();
    await pick("Untitled document");
    await openRail();
    await expect(threads.locator(".artifact-thread__post")).toHaveCount(1, { timeout: 20_000 });
    await expect(threads.locator(".artifact-thread__post").first()).toContainText("for the merge");
    await shot(page, "08-comment-after-reload");

    // The seat comments from its throwaway folder; the rail shows it.
    const seatComment = await cli(["comment", docId, "Checked the notes against the changelog, fine by me"]);
    expect(seatComment.ok, JSON.stringify(seatComment)).toBe(true);
    await expect(threads.locator(".artifact-thread__post")).toHaveCount(2, { timeout: 20_000 });
    const seatPost = threads.locator(".artifact-thread__post").filter({ hasText: "fine by me" });
    console.log("SEAT POST:", await seatPost.innerText());
    await shot(page, "09-seat-cli-comment");

    // Collapsed again, the edge counts both posts and wears the one seat that took part.
    await page.locator(".artifact-comments").getByRole("button", { name: "Comments", exact: true }).click();
    await expect(edge).toBeVisible();
    await expect(page.getByTestId("comments-edge-count")).toHaveText("2");
    await expect(page.getByTestId("comments-edge-seat")).toHaveCount(1);
    await expect(page.getByTestId("comments-edge-seat").first()).toHaveAttribute("data-seat-id", "scout");
    await expect(edge.locator("img, svg").first()).toBeVisible();
    await shot(page, "09b-rail-edge");
    await page.keyboard.press("Meta+B");
    await expect(page.getByLabel("New comment")).toBeVisible();
    await page.keyboard.press("Meta+B");
    await expect(edge).toBeVisible();

    // A text comment keeps a mark on its quote while the rail is collapsed; pressing it opens the rail on its thread.
    const posted = await page.evaluate(
      ({ canvas, node, artifactId, opId }) =>
        window.junto!.resource!.thread!.post(canvas, { kind: "artifact", nodeId: node, artifactId }, {
          opId,
          text: "This heading reads right",
          anchor: { kind: "text", quote: "Release notes", offset: 2 },
        }),
      { canvas: CANVAS, node: asNodeId("shelf"), artifactId: docId, opId: mintOpId() },
    );
    expect(posted.kind, JSON.stringify(posted)).toBe("applied");
    const mark = page.locator(".artifact-document__anchor");
    await expect(mark).toHaveCount(1, { timeout: 20_000 });
    await expect(page.getByTestId("comments-edge-count")).toHaveText("3");
    await shot(page, "09c-text-mark");
    await mark.click();
    await expect(threads.locator(".artifact-thread[data-revealed='true']")).toHaveCount(1);
    await expect(threads.locator(".artifact-thread[data-revealed='true']")).toContainText("This heading reads right");

    // Archive and restore.
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(page.locator(".artifact-archived").filter({ hasText: "Archived." })).toBeVisible({ timeout: 15_000 });
    await shot(page, "10-archived");
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(page.locator(".artifact-archived").filter({ hasText: "Archived." })).toHaveCount(0, { timeout: 15_000 });
    await expect(list().locator("button").filter({ hasText: "Untitled document" })).toBeVisible();
    await shot(page, "11-restored");
  } finally {
    await junto.close();
  }
});

/** The id of the listed artifact with this title, from `artifact list`'s data. */
const findId = (data: unknown, title: string): string => {
  const seen: string[] = [];
  const walk = (value: unknown): string | undefined => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(item);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (record.title === title && typeof (record.artifactId ?? record.id) === "string") return String(record.artifactId ?? record.id);
      for (const child of Object.values(record)) {
        const found = walk(child);
        if (found !== undefined) return found;
      }
    }
    if (typeof value === "string") seen.push(value);
    return undefined;
  };
  const id = walk(data);
  if (id === undefined) throw new Error(`no artifact titled ${title} in ${JSON.stringify(data).slice(0, 400)}`);
  return id;
};

/**
 * No command hands a seat a content ref and nothing in the window drops a
 * file onto the node, so the seat stages the bytes with the `content.stage`
 * work op and creates the file artifact with the ref.
 */
const createFile = async (
  seat: ReturnType<typeof crewSeat>,
  cli: (argv: ReadonlyArray<string>) => Promise<{ ok?: boolean }>,
): Promise<void> => {
  const bytes = Buffer.from("build 0.10.0\nall checks green\n", "utf8").toString("base64");
  const staged = await seat.op("content.stage", { bytesBase64: bytes, done: { mediaType: "text/plain", displayName: "build.log" } });
  console.log("STAGED:", JSON.stringify(staged).slice(0, 300));
  expect(staged.ok, JSON.stringify(staged)).toBe(true);
  const ref = (staged as { data?: { ref?: unknown } }).data?.ref;
  expect(ref).toBeTruthy();
  const created = await cli(["create", "Release build log", "--type", "file", "--body", JSON.stringify({ content: ref })]);
  expect(created.ok, JSON.stringify(created)).toBe(true);
};
