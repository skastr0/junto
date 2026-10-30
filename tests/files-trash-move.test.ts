import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realRoot, trashAt } from "../src/main/junto/files/fs-ops";
import { trashMove } from "../src/main/junto/files/trash-move";
import { parseFilePath, type FilePath } from "../src/shared/files";

const path = (raw: string): FilePath => parseFilePath(raw)!;
let base: string;
let root: string;
let home: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "junto-trash-"));
  root = join(base, "root");
  home = join(base, "home");
  await mkdir(root, { recursive: true });
  await mkdir(home, { recursive: true });
});
afterEach(() => rm(base, { recursive: true, force: true }));

const scope = async () => ({ root: (await realRoot(root)) as { ok: true; value: string }, deny: [] as ReadonlyArray<string> });
const trashed = async (platform: "darwin" | "linux", options: Parameters<typeof trashMove>[0] = {}) => {
  const resolved = await scope();
  return (target: string) => trashAt({ root: resolved.root.value, deny: [] }, path(target), trashMove({ platform, home, ...options }));
};
const exists = (p: string) => lstat(p).then(() => true, () => false);

describe("the trash without Electron", () => {
  it("moves into ~/.Trash on macOS and never overwrites a name already there", async () => {
    await mkdir(join(home, ".Trash"));
    await writeFile(join(home, ".Trash", "a.md"), "older");
    await writeFile(join(root, "a.md"), "newer");
    expect(await (await trashed("darwin"))("a.md")).toEqual({ ok: true, value: null });
    expect(await exists(join(root, "a.md"))).toBe(false);
    expect(await readFile(join(home, ".Trash", "a.md"), "utf8")).toBe("older");
    expect(await readFile(join(home, ".Trash", "a 2.md"), "utf8")).toBe("newer");
  });

  it("writes info/<name>.trashinfo first on Linux, then moves, and a taken name gets a number", async () => {
    const data = join(home, ".local", "share", "Trash");
    await mkdir(join(data, "files"), { recursive: true });
    await mkdir(join(data, "info"), { recursive: true });
    await writeFile(join(data, "files", "n.txt"), "older");
    await writeFile(join(data, "info", "n.txt.trashinfo"), "older info");
    await mkdir(join(root, "dir"));
    await writeFile(join(root, "dir", "n txt.txt"), "x");
    await writeFile(join(root, "n.txt"), "newer");
    // Local time, so the expectation does not depend on the zone the test runs in.
    const at = new Date(2026, 9, 29, 12, 30, 45);
    expect(await (await trashed("linux", { now: () => at }))("n.txt")).toEqual({ ok: true, value: null });
    expect(await readFile(join(data, "files", "n.txt"), "utf8")).toBe("older");
    expect(await readFile(join(data, "files", "n 2.txt"), "utf8")).toBe("newer");
    expect(await readFile(join(data, "info", "n 2.txt.trashinfo"), "utf8")).toBe(
      `[Trash Info]\nPath=${(await realRoot(root) as { value: string }).value}/n.txt\nDeletionDate=2026-10-29T12:30:45\n`,
    );
    expect(await readFile(join(data, "info", "n.txt.trashinfo"), "utf8")).toBe("older info");
    expect(await (await trashed("linux"))("dir/n txt.txt")).toEqual({ ok: true, value: null });
    expect(await readFile(join(data, "info", "n txt.txt.trashinfo"), "utf8")).toContain("/dir/n%20txt.txt\n");
  });

  it("never overwrites a name in files/ that has no info record", async () => {
    const data = join(home, ".local", "share", "Trash");
    await mkdir(join(data, "files"), { recursive: true });
    await writeFile(join(data, "files", "m.txt"), "foreign");
    await writeFile(join(root, "m.txt"), "mine");
    expect(await (await trashed("linux"))("m.txt")).toEqual({ ok: true, value: null });
    expect(await readFile(join(data, "files", "m.txt"), "utf8")).toBe("foreign");
    expect(await readFile(join(data, "files", "m 2.txt"), "utf8")).toBe("mine");
    expect(await readdir(join(data, "info"))).toEqual(["m 2.txt.trashinfo"]);
  });

  it.each(["darwin", "linux"] as const)("loses none of five same-named files trashed at once (%s)", async (platform) => {
    const trash = await trashed(platform);
    const paths = ["a", "b", "c", "d", "e"].map((folder) => `${folder}/notes.md`);
    for (const folder of ["a", "b", "c", "d", "e"]) {
      await mkdir(join(root, folder));
      await writeFile(join(root, folder, "notes.md"), `from ${folder}`);
    }
    const results = await Promise.all(paths.map((target) => trash(target)));
    expect(results).toEqual(paths.map(() => ({ ok: true, value: null })));
    const where = platform === "darwin" ? join(home, ".Trash") : join(home, ".local", "share", "Trash", "files");
    const kept = await Promise.all((await readdir(where)).map((name) => readFile(join(where, name), "utf8")));
    expect(kept.sort()).toEqual(["from a", "from b", "from c", "from d", "from e"]);
    if (platform === "linux") expect(await readdir(join(home, ".local", "share", "Trash", "info"))).toHaveLength(5);
  });

  it.each(["darwin", "linux"] as const)("loses none of five same-named folders trashed at once (%s)", async (platform) => {
    const trash = await trashed(platform);
    const names = ["a", "b", "c", "d", "e"];
    for (const folder of names) {
      await mkdir(join(root, folder, "docs"), { recursive: true });
      await writeFile(join(root, folder, "docs", "x.md"), `from ${folder}`);
    }
    const results = await Promise.all(names.map((folder) => trash(`${folder}/docs`)));
    expect(results).toEqual(names.map(() => ({ ok: true, value: null })));
    const where = platform === "darwin" ? join(home, ".Trash") : join(home, ".local", "share", "Trash", "files");
    const kept = await Promise.all((await readdir(where)).map((name) => readFile(join(where, name, "x.md"), "utf8")));
    expect(kept.sort()).toEqual(["from a", "from b", "from c", "from d", "from e"]);
  });

  it.each(["darwin", "linux"] as const)("takes its placeholder away when the move fails, and only while it is empty (%s)", async (platform) => {
    await writeFile(join(root, "keep.txt"), "kept");
    const failing = async () => { throw Object.assign(new Error("cross-device"), { code: "EXDEV" }); };
    expect(await (await trashed(platform, { move: failing }))("keep.txt")).toEqual({ ok: false, error: "denied" });
    const where = platform === "darwin" ? join(home, ".Trash") : join(home, ".local", "share", "Trash", "files");
    expect(await readdir(where)).toEqual([]);
    await mkdir(join(root, "dir"));
    expect(await (await trashed(platform, { move: failing }))("dir")).toEqual({ ok: false, error: "denied" });
    expect(await readdir(where)).toEqual([]);
    expect(await exists(join(root, "dir"))).toBe(true);
    // Someone put a file in the placeholder folder meanwhile: it is not ours to remove.
    const filling = async (_from: string, to: string) => {
      await writeFile(join(to, "theirs.txt"), "t");
      throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
    };
    expect(await (await trashed(platform, { move: filling }))("dir")).toEqual({ ok: false, error: "denied" });
    expect(await readFile(join(where, "dir", "theirs.txt"), "utf8")).toBe("t");
  });

  it("orders the info file before the move on Linux", async () => {
    await writeFile(join(root, "o.txt"), "x");
    const data = join(home, ".local", "share", "Trash");
    let infoWhenMoving = false;
    const move = async (from: string, to: string) => {
      infoWhenMoving = await exists(join(data, "info", "o.txt.trashinfo"));
      const { rename } = await import("node:fs/promises");
      await rename(from, to);
    };
    await (await trashed("linux", { move }))("o.txt");
    expect(infoWhenMoving).toBe(true);
  });

  it.each(["darwin", "linux"] as const)("refuses a move across volumes (EXDEV) as denied and leaves the file (%s)", async (platform) => {
    await writeFile(join(root, "keep.txt"), "kept");
    const move = async () => { throw Object.assign(new Error("cross-device"), { code: "EXDEV" }); };
    expect(await (await trashed(platform, { move }))("keep.txt")).toEqual({ ok: false, error: "denied" });
    expect(await readFile(join(root, "keep.txt"), "utf8")).toBe("kept");
    // Linux leaves no record for a file that did not move.
    expect(await readdir(join(home, ".local", "share", "Trash", "info")).catch(() => [])).toEqual([]);
  });

  it("trashes a symlink as the link, not its target", async () => {
    await mkdir(join(base, "elsewhere"));
    await writeFile(join(base, "elsewhere", "target.txt"), "target");
    await symlink(join(base, "elsewhere", "target.txt"), join(root, "link"));
    expect(await (await trashed("darwin"))("link")).toEqual({ ok: true, value: null });
    expect(await exists(join(root, "link"))).toBe(false);
    expect(await readlink(join(home, ".Trash", "link"))).toBe(join(base, "elsewhere", "target.txt"));
    expect(await readFile(join(base, "elsewhere", "target.txt"), "utf8")).toBe("target");
  });

  it("refuses a path outside the root before anything moves", async () => {
    await mkdir(join(base, "outside"));
    await writeFile(join(base, "outside", "secret.txt"), "s");
    await symlink(join(base, "outside"), join(root, "door"));
    const trash = await trashed("darwin");
    expect(await trash("door/secret.txt")).toEqual({ ok: false, error: "outside-root" });
    expect(await exists(join(base, "outside", "secret.txt"))).toBe(true);
    expect(await exists(join(home, ".Trash"))).toBe(false);
    // `../x` never becomes a FilePath, so the service refuses it before any trash call.
    expect(parseFilePath("../x")).toBeUndefined();
  });

  it("refuses on a system with no trash", async () => {
    await writeFile(join(root, "w.txt"), "w");
    expect(await (await trashed("win32" as "linux"))("w.txt")).toEqual({ ok: false, error: "denied" });
    expect(await exists(join(root, "w.txt"))).toBe(true);
  });
});
