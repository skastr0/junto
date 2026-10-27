/**
 * 0.11 F5, drops. A Finder drop on the Files card, on the open modal or on a
 * folder row copies the files into the folder; a name that is taken gets " 2",
 * " 3"; a drag inside the tree moves a file as a rename, and a move onto a taken
 * name is refused. Each check reads the disk, not only the screen.
 *   bun run test:e2e:fast e2e/scenarios/files-drops.spec.ts
 * The drop is staged as File objects with real paths (files-scenario.ts), the
 * stand-in for a Finder drag, which Playwright cannot start. Fixme until F5 is
 * on main; drop the describe.fixme when it lands.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator } from "@playwright/test";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture } from "../harness/model";
import {
  drop,
  dropOn,
  filesCard,
  filesNode,
  hover,
  leave,
  openFilesModal,
  stageFiles,
  transferOf,
  treeRow,
  type FilesStage,
} from "../harness/files-scenario";

const CANVAS = "files-drops";
const README = "# Fixture\n\nA root for the Files node.\n\n- one\n- two\n";

/** The element that takes the drop inside the modal: its data-drop mark follows the pointer. */
const surface = (modal: Locator): Locator => modal.locator('[data-files-drop="true"]');

const launch = async (stage: FilesStage) => launchJunto({ seedModels: { [CANVAS]: modelFixture([filesNode(stage.fixture.root)]) } });

const waitForFile = (path: string) => expect.poll(() => existsSync(path), { timeout: 15_000 }).toBe(true);

test.describe.fixme("drops into the Files node (F5)", () => {
  test("a drop on the Files card copies the file into the root, and the source stays", async () => {
    test.setTimeout(120_000);
    const stage = await stageFiles();
    const junto = await launch(stage);
    try {
      const { page } = junto;
      await expect(filesCard(page)).toBeVisible({ timeout: 30_000 });
      const source = await stage.incoming("desk/new-note.md", "from the desk\n");

      await drop(filesCard(page), await transferOf(page, [source]));

      const copied = join(stage.fixture.root, "new-note.md");
      await waitForFile(copied);
      expect(readFileSync(copied, "utf8")).toBe("from the desk\n");
      expect(existsSync(source)).toBe(true);
    } finally {
      await junto.close();
      await stage.cleanup();
    }
  });

  test("a drop on the open modal copies into the root, and the tree lists the new file without a reopen", async () => {
    test.setTimeout(120_000);
    const stage = await stageFiles();
    const junto = await launch(stage);
    try {
      const { page } = junto;
      const modal = await openFilesModal(page);
      const source = await stage.incoming("desk/modal-drop.md", "from the modal\n");

      await drop(surface(modal), await transferOf(page, [source]));

      await expect(treeRow(modal, "modal-drop.md")).toBeVisible({ timeout: 15_000 });
      expect(readFileSync(join(stage.fixture.root, "modal-drop.md"), "utf8")).toBe("from the modal\n");
    } finally {
      await junto.close();
      await stage.cleanup();
    }
  });

  test("a drop on a folder row copies into that folder, and the row is marked while the drag hovers it", async () => {
    test.setTimeout(120_000);
    const stage = await stageFiles();
    const junto = await launch(stage);
    try {
      const { page } = junto;
      const modal = await openFilesModal(page);
      const source = await stage.incoming("desk/folder-drop.md", "into nested\n");
      const transfer = await transferOf(page, [source]);

      await hover(treeRow(modal, "nested"), transfer);
      await expect(surface(modal)).toHaveAttribute("data-drop", "folder");

      await dropOn(treeRow(modal, "nested"), transfer);
      await waitForFile(join(stage.fixture.root, "nested", "folder-drop.md"));
      expect(existsSync(join(stage.fixture.root, "folder-drop.md"))).toBe(false);
      await expect(surface(modal)).not.toHaveAttribute("data-drop", "folder");
    } finally {
      await junto.close();
      await stage.cleanup();
    }
  });

  test("a drag over the bare modal marks the root, and leaving clears the mark", async () => {
    test.setTimeout(120_000);
    const stage = await stageFiles();
    const junto = await launch(stage);
    try {
      const { page } = junto;
      const modal = await openFilesModal(page);
      const transfer = await transferOf(page, [await stage.incoming("desk/hover.md", "hover\n")]);

      await hover(surface(modal), transfer);
      await expect(surface(modal)).toHaveAttribute("data-drop", "root");

      await leave(surface(modal), transfer);
      await expect(surface(modal)).not.toHaveAttribute("data-drop", "root");
      expect(existsSync(join(stage.fixture.root, "hover.md"))).toBe(false);
    } finally {
      await junto.close();
      await stage.cleanup();
    }
  });

  test("a name that is taken gets ' 2', then ' 3', and nothing already there is overwritten", async () => {
    test.setTimeout(120_000);
    const stage = await stageFiles();
    const junto = await launch(stage);
    try {
      const { page } = junto;
      const modal = await openFilesModal(page);
      const root = stage.fixture.root;

      await drop(surface(modal), await transferOf(page, [await stage.incoming("one/README.md", "incoming one\n")]));
      await waitForFile(join(root, "README 2.md"));
      expect(readFileSync(join(root, "README 2.md"), "utf8")).toBe("incoming one\n");

      await drop(surface(modal), await transferOf(page, [await stage.incoming("two/README.md", "incoming two\n")]));
      await waitForFile(join(root, "README 3.md"));
      expect(readFileSync(join(root, "README 3.md"), "utf8")).toBe("incoming two\n");

      expect(readFileSync(join(root, "README.md"), "utf8")).toBe(README);
      expect(readFileSync(join(root, "README 2.md"), "utf8")).toBe("incoming one\n");
    } finally {
      await junto.close();
      await stage.cleanup();
    }
  });

  test("an accented name keeps its letters: café.md dropped on notes becomes café 2.md there", async () => {
    test.setTimeout(120_000);
    const stage = await stageFiles();
    const junto = await launch(stage);
    try {
      const { page } = junto;
      const modal = await openFilesModal(page);
      const source = await stage.incoming("desk/café.md", "# Café, again\n");

      await drop(treeRow(modal, "notes"), await transferOf(page, [source]));

      const copied = join(stage.fixture.root, "notes", "café 2.md");
      await waitForFile(copied);
      expect(readFileSync(copied, "utf8")).toBe("# Café, again\n");
      expect(readFileSync(join(stage.fixture.root, "notes", "café.md"), "utf8")).toBe("# Café\n");
    } finally {
      await junto.close();
      await stage.cleanup();
    }
  });

  test("a drag inside the tree moves a file as a rename, not a copy", async () => {
    test.setTimeout(120_000);
    const stage = await stageFiles();
    const junto = await launch(stage);
    try {
      const { page } = junto;
      const modal = await openFilesModal(page);
      const root = stage.fixture.root;

      await treeRow(modal, "notes").click();
      await treeRow(modal, "notes/meeting notes.txt").dragTo(treeRow(modal, "src"));

      await waitForFile(join(root, "src", "meeting notes.txt"));
      expect(readFileSync(join(root, "src", "meeting notes.txt"), "utf8")).toBe("spaced name\n");
      expect(existsSync(join(root, "notes", "meeting notes.txt"))).toBe(false);
    } finally {
      await junto.close();
      await stage.cleanup();
    }
  });

  test("a tree move onto a taken name is refused, says so, and moves nothing", async () => {
    test.setTimeout(120_000);
    const stage = await stageFiles();
    const junto = await launch(stage);
    try {
      const { page } = junto;
      const modal = await openFilesModal(page);
      const root = stage.fixture.root;

      // Put a café.md into nested first, so the tree move has a taken name to meet.
      await drop(treeRow(modal, "nested"), await transferOf(page, [await stage.incoming("desk/café.md", "taken\n")]));
      await waitForFile(join(root, "nested", "café.md"));

      await treeRow(modal, "notes").click();
      await treeRow(modal, "notes/café.md").dragTo(treeRow(modal, "nested"));

      await expect(modal.getByRole("alert").filter({ hasText: "Nothing moved." })).toBeVisible({ timeout: 15_000 });
      expect(readFileSync(join(root, "notes", "café.md"), "utf8")).toBe("# Café\n");
      expect(readFileSync(join(root, "nested", "café.md"), "utf8")).toBe("taken\n");
    } finally {
      await junto.close();
      await stage.cleanup();
    }
  });
});
