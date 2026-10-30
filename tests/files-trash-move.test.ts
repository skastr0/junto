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
    const at = new Date("2026-10-29T12:30:45.000Z");
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
