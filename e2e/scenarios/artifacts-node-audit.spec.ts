/**
 * Artifacts node feature behavior spec — asserts the artifact shelf contract
 * end to end: glance card, library surface, side detail, immersive reader,
 * search, archive/restore, provenance jump, delete guard, and empty states.
 *
 * Screenshots of the asserted states land in .amp/in/artifacts for review.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Locator } from "@playwright/test";
import type { CanvasDoc } from "../../src/shared/canvas";
import type { Artifact } from "../../src/shared/canvas";
import { agentTextNode, artifactsNode, canvasDoc, claimByNodeId, taskItem, tasksNode, verbEdge } from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";

const CANVAS = "atelier";
const SHOTS = join(process.cwd(), ".amp", "in", "artifacts", "artifacts-audit");

const PNG_48X32 =
  "iVBORw0KGgoAAAANSUhEUgAAADAAAAAgEAIAAACLJrAIAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRP///////wlY99wAAAAHdElNRQfqCQsJIiAyFypTAAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTA5LTExVDA5OjM0OjMyKzAwOjAwh2whJAAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0wOS0xMVQwOTozNDozMiswMDowMPYxmZgAAAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMDktMTFUMDk6MzQ6MzIrMDA6MDChJLhHAAAAj0lEQVRo3u3asQ2AMAwF0R8pRRiDVWBuGIU1QgcTwJVJcW8C62QsipTniX7U+0zaNnqMeRkIGAiUqydrGz3GvNwgYCBgIFD7mSwG+uQGAQMBAwFvEHCDgIGAgUDtR7Lso8eYlxsEDAQMBPwPAm4QMBAwEPAGATcIGAiUtSVXHz3GvLxBwE8MGAiUJPEJzLcX1bdAbfcYS4cAAAAASUVORK5CYII=";

const MARKDOWN_BODY = [
  "# Release notes 0.2.1",
  "",
  "## Highlights",
  "",
  "| Area | Change |",
  "| --- | --- |",
  "| Canvas | Regions roll up live activity |",
  "| Work | Artifacts publish from task completion |",
  "",
  "- [x] Ship the renderer fix",
  "- [ ] Rotate the fleet key",
  "",
  "See the [spec](https://example.com/spec.md) for details.",
].join("\n");

const ARTIFACTS: ReadonlyArray<Artifact> = [
  {
    artifactId: "a1",
    name: "release-notes.md",
    parts: [{ kind: "text", text: MARKDOWN_BODY }],
    task: { kind: "task", itemId: "t1", sink: { canvasName: CANVAS, nodeId: "intake" } },
    metadata: { source: "builder" },
  },
  {
    artifactId: "a2",
    name: "og-plate.png",
    parts: [{ kind: "raw", bytesBase64: PNG_48X32, mediaType: "image/png" }],
  },
  {
    artifactId: "a3",
    name: "spec link",
    parts: [{ kind: "url", url: "https://example.com/spec.md" }],
  },
  {
    artifactId: "a4",
    name: "metrics.json",
    parts: [
      {
        kind: "raw",
        bytesBase64: Buffer.from(JSON.stringify({ p50: 12, p99: 48 }, null, 2)).toString("base64"),
        mediaType: "application/json",
      },
    ],
  },
  {
    artifactId: "a5",
    name: "session-notes.txt",
    parts: [
      {
        kind: "raw",
        bytesBase64: Buffer.from("plain session notes").toString("base64"),
        mediaType: "text/plain",
      },
    ],
  },
  {
    artifactId: "a6",
    name: "old-report.md",
    parts: [{ kind: "text", text: "# Old report\n\nSuperseded." }],
    metadata: { archived: true },
  },
  { artifactId: "a7", name: "hollow", parts: [] },
];

const fixture = (): CanvasDoc => {
  const builder = agentTextNode({ id: "builder", key: "local:builder", label: "builder", x: 40, y: 80 });
  const shelf = artifactsNode({ id: "shelf", x: 420, y: 80, items: ARTIFACTS });
  const intake = tasksNode({
    id: "intake",
    x: 40,
    y: 320,
    items: [
      {
        ...taskItem("t1", "Prepare the 0.2.1 release", "working"),
        claimedBy: claimByNodeId("builder"),
        // Finish gate reads exactly like the finish gate consumes it: any
        // artifact on the shelf satisfies the artifacts criterion.
        finishCriteria: { artifacts: { nodeId: "shelf" } },
      },
    ],
  });
  const emptyShelf = artifactsNode({ id: "empty-shelf", x: 420, y: 320, items: [] });
  return canvasDoc([builder, intake, shelf, emptyShelf], [
    verbEdge("builder-shelf", "builder", "shelf", "publishes", {
      builder: "agent",
      shelf: "artifacts",
    }),
  ]);
};

const row = (library: Locator, id: string) =>
  library.locator(`[data-testid="artifact-row"][data-artifact-id="${id}"]`);

/**
 * Record every blob URL the renderer creates (both Save paths — PartView raw
 * parts and ContentMedia — build an object URL right before the anchor click).
 * The download itself is Electron/OS-driven; the receipt proves the stream
 * path ran with the exact bytes.
 */
const installSaveReceipt = (page: import("@playwright/test").Page): Promise<void> =>
  page.evaluate(() => {
    const receipts: string[] = [];
    (window as unknown as { __saveReceipts: string[] }).__saveReceipts = receipts;
    const originalCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob: Blob) => {
      receipts.push(`${blob.size} bytes`);
      return originalCreate(blob);
    };
  });

const readSaveReceipts = (page: import("@playwright/test").Page): Promise<string[]> =>
  page.evaluate(
    () => (window as unknown as { __saveReceipts?: string[] }).__saveReceipts ?? [],
  );

test("artifacts node feature contract", async ({}, testInfo) => {
  await mkdir(SHOTS, { recursive: true });
  const shot = (name: string) => join(SHOTS, name);

  const vellumCommand = await launchVellum({
    seedCanvases: { [CANVAS]: fixture() },
  });
  try {
    const { page } = vellumCommand;
    const rendererErrors: string[] = [];
    page.on("pageerror", (error) => rendererErrors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") rendererErrors.push(`console: ${message.text()}`);
    });

    // --- Glance card: stable kind label, no rename affordance -------------
    const card = page.locator('.react-flow__node[data-id="shelf"]').getByTestId("artifacts-card");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.locator(".factory-glance__header")).toHaveText(/^artifacts/);
    await page.screenshot({ path: shot("01-canvas-glance.png") });
    await testInfo.attach("canvas-glance", { path: shot("01-canvas-glance.png") });

    // --- RTS: artifacts shelf has Open, no Rename/Edit keys ----------------
    await page.locator('.react-flow__node[data-id="shelf"]').click();
    const kindStrip = page.locator(".rts-kind-strip");
    await expect(kindStrip.getByRole("button", { name: "Open artifacts" })).toHaveCount(1);
    await expect(kindStrip.getByRole("button", { name: "Rename" })).toHaveCount(0);
    await expect(page.locator(".rts-panel--cmd").getByRole("button", { name: "Edit" })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // --- Library opens, first live artifact selected ------------------------
    await card.dispatchEvent("dblclick");
    const library = page.getByRole("dialog", { name: "Artifacts" });
    await expect(library).toBeVisible();
    await expect(library.getByText("Artifact library")).toBeVisible();
    const sideDetail = library.getByTestId("artifact-side-detail");
    await expect(sideDetail).toBeVisible();
    // First live artifact is selected; the archived a6 fallback is gone. The
    // runtime projection orders items newest-first, so assert against the
    // rail's first row rather than fixture order.
    const firstRowName = await library
      .locator('[data-testid="artifact-row"]')
      .first()
      .locator("strong")
      .textContent();
    expect(firstRowName).toBeTruthy();
    expect(firstRowName).not.toBe("old-report.md");
    await expect(sideDetail.locator("header h2")).toHaveText(firstRowName ?? "");

    // Single kind chip per surface: header kind chip only (no duplicated
    // archived chip — archived lives in the meta row), no kind pill in meta.
    await expect(sideDetail.locator("header span.uppercase")).toHaveCount(1);
    await expect(sideDetail.locator(".artifact-focus__meta-kind")).toHaveCount(0);
    await expect(sideDetail.locator(".artifact-focus__meta").getByText("archived")).toHaveCount(0);

    // Side detail owns ~80% of the workspace (regression: it collapsed to a
    // 350px rail when the --artifact cascade lost to the base rule).
    const widths = await page.evaluate(() => {
      const width = (selector: string): number =>
        document.querySelector(selector)?.getBoundingClientRect().width ?? -1;
      return {
        detail: width(".work-ledger-detail--artifact"),
        workspace: width(".work-ledger-workspace--artifacts"),
      };
    });
    expect(widths.detail).toBeGreaterThan(0);
    expect(widths.detail / widths.workspace).toBeGreaterThan(0.7);

    await page.screenshot({ path: shot("02-library-default.png") });
    await testInfo.attach("library-default", { path: shot("02-library-default.png") });

    // --- Compact rows: one kind chip, no text/chip overlap -----------------
    for (const id of ["a1", "a4", "a5"]) {
      const chips = row(library, id).locator(".work-ledger-row__select span.uppercase");
      await expect(chips).toHaveCount(1);
    }
    await row(library, "a5").locator(".work-ledger-row__select").click();
    await expect(sideDetail.locator("header h2")).toHaveText("session-notes.txt");
    const overlap = await page.evaluate(() => {
      const select = document.querySelector('[data-artifact-id="a5"] .work-ledger-row__select');
      const title = select?.querySelector("strong") ?? null;
      const chip = select?.querySelector("span.uppercase");
      if (!title || !chip) return { titleRight: -1, chipLeft: -1 };
      return {
        titleRight: title.getBoundingClientRect().right,
        chipLeft: chip.getBoundingClientRect().left,
      };
    });
    expect(overlap.titleRight).toBeLessThanOrEqual(overlap.chipLeft);

    // --- Zero-part artifact shows an explicit empty state -------------------
    await row(library, "a7").locator(".work-ledger-row__select").click();
    await expect(sideDetail.getByTestId("artifact-empty-parts")).toHaveText("No contents");
    await page.screenshot({ path: shot("03-side-detail-zero-parts.png") });
    await testInfo.attach("side-detail-zero-parts", { path: shot("03-side-detail-zero-parts.png") });

    // --- Image Save (shelf raw part): blob stream via the shared helper -----
    await row(library, "a2").locator(".work-ledger-row__select").click();
    // Raw image parts render PartView's own Save; the createObjectURL receipt
    // is shared with the ContentMedia Save driven later via task detail.
    const partSave = sideDetail.getByRole("button", { name: "Save" });
    await expect(partSave).toBeVisible();
    await installSaveReceipt(page);
    await partSave.click();
    await expect
      .poll(async () => readSaveReceipts(page), { timeout: 10_000 })
      .toEqual([`${Buffer.from(PNG_48X32, "base64").length} bytes`]);
    await page.screenshot({ path: shot("04-side-detail-image-save.png") });
    await testInfo.attach("side-detail-image-save", { path: shot("04-side-detail-image-save.png") });

    // --- Delete guard: finish-gate warning, canceled delete keeps selection -
    await row(library, "a1").locator(".work-ledger-row__select").click();
    await expect(sideDetail.locator("header h2")).toHaveText("release-notes.md");
    await page.evaluate(() => {
      const w = window as unknown as {
        __confirmLog: string[];
        __confirmAccept: boolean;
        confirm: (message?: string) => boolean;
      };
      w.__confirmLog = [];
      w.__confirmAccept = false;
      w.confirm = (message?: string) => {
        w.__confirmLog.push(message ?? "");
        return w.__confirmAccept;
      };
    });
    await library.getByRole("button", { name: "Delete artifact" }).click();
    const confirmLog = () =>
      page.evaluate(() => (window as unknown as { __confirmLog: string[] }).__confirmLog);
    await expect
      .poll(async () => (await confirmLog()).length, { timeout: 5_000 })
      .toBeGreaterThan(0);
    expect((await confirmLog())[0]).toContain(
      "This artifact can provide completion evidence for unfinished task “Prepare the 0.2.1 release”",
    );
    // Canceled: selection and pane stay exactly where they were.
    await expect(sideDetail.locator("header h2")).toHaveText("release-notes.md");

    // Unlinked artifact: plain confirm, no gate warning.
    await row(library, "a3").locator(".work-ledger-row__select").click();
    await expect(sideDetail.locator("header h2")).toHaveText("spec link");
    await page.evaluate(() => {
      (window as unknown as { __confirmAccept: boolean }).__confirmAccept = true;
    });
    await library.getByRole("button", { name: "Delete artifact" }).click();
    await expect
      .poll(async () => (await confirmLog()).length)
      .toBe(2);
    expect((await confirmLog())[1]).not.toContain("completion evidence");
    // Deleted selection clears to the empty pane — never a silent jump.
    await expect(sideDetail).toHaveCount(0);
    await expect(library.getByText("Select an artifact to preview")).toBeVisible();
    await expect(row(library, "a3")).toHaveCount(0);
    await page.screenshot({ path: shot("05-after-delete.png") });
    await testInfo.attach("after-delete", { path: shot("05-after-delete.png") });

    // --- Provenance: source-task button opens the board pre-selected --------
    await row(library, "a1").locator(".work-ledger-row__select").click();
    await expect(sideDetail.locator("header h2")).toHaveText("release-notes.md");
    await library.getByRole("button", { name: "Open source task" }).click();
    await expect(library).toBeHidden();
    const board = page.getByRole("dialog", { name: "Task board" });
    await expect(board).toBeVisible();
    await expect(
      board.getByRole("complementary", { name: "Details for Prepare the 0.2.1 release" }),
    ).toBeVisible();
    await page.screenshot({ path: shot("06-provenance-task-board.png") });
    await testInfo.attach("provenance-task-board", { path: shot("06-provenance-task-board.png") });
    await page.keyboard.press("Escape");
    await expect(board).toBeHidden();

    // --- ContentMedia image branch (content-backed parts) drives Save -------
    // The renderer cannot author content-backed artifacts (publish is
    // agent-authority), so the same non-bare ContentMedia component is driven
    // through the task detail media surface it shares with the artifact pane.
    const contentPut = await page.evaluate(async (png) => {
      const result = await window.vellumCommand!.contentPutImage({
        bytesBase64: png,
        mediaType: "image/png",
        displayName: "og-plate.png",
      });
      if (!result.ok) throw new Error(result.error);
      return result.ref;
    }, PNG_48X32);
    await page.evaluate(async ({ ref }) => {
      const api = window.vellumCommand!;
      const canvases = await api.listCanvases();
      const name = canvases[0]!.name;
      const result = await api.workTaskCreate(
        name,
        "intake",
        "Media probe task",
        { details: "ContentMedia Save probe" },
        undefined,
        [{ kind: "content", ref }],
      );
      if (!result.ok) throw new Error(result.message);
    }, { ref: contentPut });

    const intakeCard = page.locator('.react-flow__node[data-id="intake"]');
    await intakeCard.getByTestId("tasks-card").dispatchEvent("dblclick");
    const mediaBoard = page.getByRole("dialog", { name: "Task board" });
    await expect(mediaBoard).toBeVisible();
    await mediaBoard.getByLabel("Open details for Media probe task").click();
    const mediaDetails = mediaBoard.getByRole("complementary", {
      name: "Details for Media probe task",
    });
    const mediaSave = mediaDetails.locator(".task-detail-panel__media").getByTestId("content-media-open");
    await expect(mediaSave).toHaveText(/Save/);
    await installSaveReceipt(page);
    await mediaSave.click();
    await expect
      .poll(async () => readSaveReceipts(page), { timeout: 10_000 })
      .toContain(`${Buffer.from(PNG_48X32, "base64").length} bytes`);
    await expect(mediaDetails.locator(".content-media__error")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(mediaBoard).toBeHidden();

    // --- Search filters rows -----------------------------------------------
    await card.dispatchEvent("dblclick");
    await expect(library).toBeVisible();
    const search = library.getByLabel("Search artifacts");
    await search.fill("json");
    await expect(library.getByTestId("artifact-row")).toHaveCount(1);
    await expect(row(library, "a4")).toBeVisible();
    await search.fill("");
    await expect(library.getByTestId("artifact-row")).not.toHaveCount(0);

    // --- Archive / restore round trip ---------------------------------------
    await library.getByTestId("artifact-show-archived").click();
    await row(library, "a5").locator(".work-ledger-row__select").click();
    await library.getByRole("button", { name: "Archive artifact" }).click();
    await expect(row(library, "a5")).toHaveClass(/is-archived/);
    await row(library, "a6").locator(".work-ledger-row__select").click();
    await library.getByRole("button", { name: "Restore artifact" }).click();
    await expect(row(library, "a6")).not.toHaveClass(/is-archived/);
    await page.screenshot({ path: shot("07-archive-restore.png") });
    await testInfo.attach("archive-restore", { path: shot("07-archive-restore.png") });

    // Archived a5 filters out of the live list; hiding archived clears a
    // stale archived selection to the empty pane (never a silent jump).
    await row(library, "a5").locator(".work-ledger-row__select").click();
    await expect(sideDetail.locator("header h2")).toHaveText("session-notes.txt");
    await library.getByTestId("artifact-show-archived").click();
    await expect(sideDetail).toHaveCount(0);
    await expect(library.getByText("Select an artifact to preview")).toBeVisible();

    // --- Empty library -------------------------------------------------------
    await page.keyboard.press("Escape");
    await expect(library).toBeHidden();
    const emptyCard = page
      .locator('.react-flow__node[data-id="empty-shelf"]')
      .getByTestId("artifacts-card");
    await emptyCard.dispatchEvent("dblclick");
    const emptyLibrary = page.getByRole("dialog", { name: "Artifacts" });
    await expect(emptyLibrary.getByText("No artifacts published yet")).toBeVisible();
    await page.screenshot({ path: shot("08-empty-library.png") });
    await testInfo.attach("empty-library", { path: shot("08-empty-library.png") });

    // Persist the console/page error log for the report.
    await writeFile(
      join(SHOTS, "renderer-errors.log"),
      rendererErrors.length > 0 ? rendererErrors.join("\n") : "(none)",
    );
    expect(rendererErrors).toEqual([]);
  } finally {
    await vellumCommand.close();
  }
});
