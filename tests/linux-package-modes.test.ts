import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLinuxRuntimeDraft,
  listUnexecutableElfPrograms,
} from "../scripts/finalize-linux-package";

const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60)]);
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A linux-unpacked tree as electron-builder leaves it: every file at 0644. */
const attemptWith = async (files: Readonly<Record<string, Buffer>>): Promise<string> => {
  const parent = await mkdtemp(path.join(tmpdir(), "junto-modes-"));
  roots.push(parent);
  const attempt = path.join(parent, ".junto-package-attempt-test");
  await mkdir(path.join(attempt, "linux-unpacked"), { recursive: true, mode: 0o700 });
  for (const [name, bytes] of Object.entries(files)) {
    const file = path.join(attempt, "linux-unpacked", name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes, { mode: 0o644 });
  }
  return attempt;
};

const executable = async (file: string): Promise<boolean> =>
  ((await stat(file)).mode & 0o111) !== 0;

describe("Linux package modes", () => {
  it("ships chrome_crashpad_handler and every other ELF program executable", async () => {
    const attempt = await attemptWith({
      junto: ELF,
      "resources/bin/junto": ELF,
      chrome_crashpad_handler: ELF,
      "libffmpeg.so": ELF,
      "libvulkan.so.1": ELF,
      "resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node": ELF,
      "resources.pak": Buffer.from("not a program"),
    });
    const draft = await createLinuxRuntimeDraft({
      attemptDirectory: attempt,
      version: "0.0.1",
      arch: "x64",
    });
    expect(await listUnexecutableElfPrograms(draft.artifact)).toEqual([]);
    expect(await executable(path.join(draft.artifact, "chrome_crashpad_handler"))).toBe(true);
    expect(await executable(path.join(draft.artifact, "resources.pak"))).toBe(false);
  });

  it("fails the build, not the launch, when an ELF program is missing from the executable names", async () => {
    const attempt = await attemptWith({
      junto: ELF,
      "resources/bin/junto": ELF,
      "some_new_helper": ELF,
    });
    await expect(
      createLinuxRuntimeDraft({ attemptDirectory: attempt, version: "0.0.1", arch: "x64" }),
    ).rejects.toThrow(/without the execute bit.*some_new_helper/u);
  });

  it("lists a non-executable ELF program and leaves shared objects and plain files alone", async () => {
    const attempt = await attemptWith({
      helper: ELF,
      "libx.so.2": ELF,
      "data.bin": Buffer.from("plain"),
    });
    expect(await listUnexecutableElfPrograms(path.join(attempt, "linux-unpacked"))).toEqual(["helper"]);
  });
});
