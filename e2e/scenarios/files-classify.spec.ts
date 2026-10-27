/**
 * 0.11 F6, the main pane picks the viewer by the file's kind, not by whether
 * its bytes decode as text. A PDF whose every byte is ASCII (valid, and what
 * many writers emit uncompressed) opens in the PDF viewer, never as source in
 * the code editor.
 *   bun run test:e2e:fast e2e/scenarios/files-classify.spec.ts
 */
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture } from "../harness/model";
import { filesNode, openFilesModal, openInTree, stageFiles } from "../harness/files-scenario";

test("an ASCII-only PDF opens in the PDF viewer, not the code editor", async () => {
  test.setTimeout(120_000);
  const stage = await stageFiles();
  const junto = await launchJunto({ seedModels: { "files-classify": modelFixture([filesNode(stage.fixture.root)]) } });
  try {
    const modal = await openFilesModal(junto.page);
    await openInTree(modal, stage.fixture.paths.asciiPdf);
    await expect(modal.getByTestId("pdf-viewer").getByTestId("pdf-page")).toHaveCount(2, { timeout: 30_000 });
    await expect(modal.getByText("%PDF-1.4")).toHaveCount(0);
  } finally {
    await junto.close();
    await stage.cleanup();
  }
});
