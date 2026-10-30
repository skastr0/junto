import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFilePath, type FilePath } from "../src/shared/files";
import { pairRenames, probePath, type FileId } from "../src/main/junto/files/outside-renames";

const p = (path: string): FilePath => parseFilePath(path)!;

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-outside-renames-"));
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "docs/a.md"), "a");
  await writeFile(join(root, "docs/b.md"), "b");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** What a read records: each file's id. */
const knownOf = async (...paths: string[]): Promise<Map<FilePath, FileId>> => {
  const known = new Map<FilePath, FileId>();
  for (const path of paths) {
    const probe = await probePath(join(root, path));
    if (probe.kind !== "file") throw new Error(`${path} is not a file`);
    known.set(p(path), probe.id);
  }
  return known;
};

describe("renames made outside Junto", () => {
  it("pairs a file Junto read with the path it was renamed to", async () => {
    const known = await knownOf("docs/a.md");
    await rename(join(root, "docs/a.md"), join(root, "docs/renamed.md"));
    expect(await pairRenames(root, [p("docs/a.md"), p("docs/renamed.md")], known)).toEqual({
      moves: [{ from: "docs/a.md", to: "docs/renamed.md" }],
      unpaired: [],
      expired: [],
    });
  });

  it("pairs a folder renamed over a file Junto read", async () => {
    const known = await knownOf("docs/a.md");
    await rename(join(root, "docs"), join(root, "notes"));
    expect(await pairRenames(root, [p("docs"), p("notes")], known)).toEqual({
      moves: [{ from: "docs", to: "notes" }],
      unpaired: [],
      expired: [],
    });
  });

  it("does not pair a delete and an unrelated new file", async () => {
    const known = await knownOf("docs/a.md");
    await rm(join(root, "docs/a.md"));
    await writeFile(join(root, "docs/new.md"), "a");
    expect(await pairRenames(root, [p("docs/a.md"), p("docs/new.md")], known)).toEqual({
      moves: [],
      unpaired: ["docs/a.md"],
      expired: [],
    });
  });

  it("pairs a rename whose two halves fall in two batches, and holds a gone path for one batch only", async () => {
    const known = await knownOf("docs/a.md", "docs/b.md");
    await rename(join(root, "docs/a.md"), join(root, "docs/later.md"));
    await rm(join(root, "docs/b.md"));
    // The first batch names the gone paths only (the new name has not been told yet).
    const first = await pairRenames(root, [p("docs/a.md"), p("docs/b.md")], known);
    expect(first).toEqual({ moves: [], unpaired: ["docs/a.md", "docs/b.md"], expired: [] });
    const second = await pairRenames(root, [p("docs/later.md")], known, first.unpaired);
    expect(second).toEqual({ moves: [{ from: "docs/a.md", to: "docs/later.md" }], unpaired: [], expired: ["docs/b.md"] });
  });

  it("does not pair a new file that took a deleted file's inode (ext4, tmpfs)", async () => {
    const known = await knownOf("docs/a.md");
    const a = known.get(p("docs/a.md"))!;
    const [dev, ino] = a.split(":");
    await rm(join(root, "docs/a.md"));
    // The new file reuses the inode, as ext4 does at once; its birth time, size and mtime are its own.
    const reused = async (absolute: string) =>
      absolute.endsWith("new.md") ? { kind: "file" as const, id: [dev, ino, "1", "99", "1"].join(":") } : probePath(absolute);
    expect(await pairRenames(root, [p("docs/a.md"), p("docs/new.md")], known, [], reused)).toEqual({
      moves: [],
      unpaired: ["docs/a.md"],
      expired: [],
    });
  });

  it("probes nothing when no path Junto read is named", async () => {
    const known = await knownOf("docs/a.md");
    let probes = 0;
    const counting = async (absolute: string) => {
      probes += 1;
      return probePath(absolute);
    };
    expect(await pairRenames(root, [p("docs/b.md"), p("src/x.ts")], known, [], counting)).toEqual({ moves: [], unpaired: [], expired: [] });
    expect(probes).toBe(0);
  });
});
