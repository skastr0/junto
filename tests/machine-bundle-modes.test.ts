import { chmod, link, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { normalizeMachineBundleModes } from "../scripts/machine-bundle-modes";
import { inspectMachineBundle, machineBundleFiles } from "../src/main/junto/hosts/bundle";

it("turns permissive build output into a package the strict installer can admit", async () => {
  const root = await mkdtemp(join(tmpdir(), "junto-bundle-modes-"));
  try {
    for (const directory of ["bin", "core", "core/node_modules/@xterm/headless"]) await mkdir(join(root, directory), { recursive: true });
    for (const name of ["bin/node", "bin/junto", "core/junto.cjs", "core/node_modules/@xterm/headless/package.json"]) {
      await writeFile(join(root, name), "fixture\n");
      await chmod(join(root, name), 0o666);
    }
    for (const name of ["bin/node", "bin/junto"]) await chmod(join(root, name), 0o777);
    const manifest = async () => writeFile(join(root, "manifest.json"), JSON.stringify({ build: "a".repeat(64), target: "linux-x64", node: "26.10.0", appVersion: "1", files: await machineBundleFiles(root) }));
    await manifest();
    await expect(inspectMachineBundle(root)).rejects.toThrow("must not be writable by others");
    await chmod(root, 0o777);
    await normalizeMachineBundleModes(root);
    await manifest();
    const checked = await inspectMachineBundle(root);
    expect(checked.files.every(file => (file.mode & 0o022) === 0)).toBe(true);
    expect(checked.files.find(file => file.path.endsWith("package.json"))?.mode).toBe(0o644);
    expect(checked.files.find(file => file.path === "bin/junto")?.mode).toBe(0o755);
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(root, "core/node_modules/@xterm/headless"))).mode & 0o777).toBe(0o755);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("refuses a hard link without changing the linked source file", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "junto-bundle-hardlink-"));
  try {
    const root = join(scratch, "stage"), target = join(scratch, "source");
    await mkdir(root);
    await writeFile(target, "keep", { mode: 0o600 });
    await link(target, join(root, "linked"));
    await expect(normalizeMachineBundleModes(root)).rejects.toThrow("hard link");
    expect((await lstat(target)).mode & 0o777).toBe(0o600);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
