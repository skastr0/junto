import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readHostDirectory } from "../src/main/junto/term/host-directory";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("host directory browser", () => {
  it("returns a canonical, bounded directory page with folders first", async () => {
    const root = mkdtempSync(join(tmpdir(), "junto-host-directory-"));
    roots.push(root);
    mkdirSync(join(root, "z-folder"));
    mkdirSync(join(root, "a-folder"));
    writeFileSync(join(root, "a-file.txt"), "hello");

    const result = await readHostDirectory(root);

    expect(result.root).toBe(realpathSync(root));
    expect(result.entries.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: "a-folder", kind: "directory" },
      { name: "z-folder", kind: "directory" },
      { name: "a-file.txt", kind: "file" },
    ]);
    expect(result.entries.every((entry) => entry.path.startsWith(result.root))).toBe(true);
  });

  it("rejects relative paths and files", async () => {
    const root = mkdtempSync(join(tmpdir(), "junto-host-directory-"));
    roots.push(root);
    const file = join(root, "file.txt");
    writeFileSync(file, "hello");

    await expect(readHostDirectory("relative/path")).rejects.toThrow(
      /absolute or start with ~/,
    );
    await expect(readHostDirectory(file)).rejects.toThrow(/does not name a directory/);
  });
});
