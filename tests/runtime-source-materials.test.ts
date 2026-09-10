import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../third_party/bun-1.3.13/runtime-source-catalog.json", () => ({
  default: [{
    id: "fixture",
    file: "fixture-source.tar.gz",
    bytes: 14,
    sha256: "6ffe571c73cfbee7931afb6f08bc6bbb20ed82a2191f205a86b1bbfd190d42af",
    sourceUrl: "https://example.invalid/fixture.tar.gz",
    revision: "a".repeat(40),
    repository: "https://example.invalid/fixture",
    preparation: "download",
  }],
}));

import {
  decodeRuntimeSourceIndex,
  prepareRuntimeSources,
  verifyRuntimeSources,
  RUNTIME_SOURCE_INDEX,
  RUNTIME_SOURCE_MATERIALS,
  RUNTIME_SOURCE_SCHEMA,
  RUNTIME_ELECTRON_VERSION,
} from "../scripts/prepare-runtime-sources";

const roots: string[] = [];
const body = "source fixture";
const temporary = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "vellum-command-runtime-source-test-"));
  roots.push(directory);
  return directory;
};
const index = () => ({
  schema: RUNTIME_SOURCE_SCHEMA,
  bunVersion: "1.3.13",
  electronVersion: RUNTIME_ELECTRON_VERSION,
  files: RUNTIME_SOURCE_MATERIALS.map(({ id, file, bytes, sha256, sourceUrl, revision }) =>
    ({ id, file, bytes, sha256, sourceUrl, revision })),
});
const download = () => vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("pinned runtime source preparation", () => {
  it("downloads fresh material, verifies it, and reuses verified bytes", async () => {
    expect(createHash("sha256").update(body).digest("hex")).toBe(index().files[0]!.sha256);
    const destinationDirectory = await temporary();
    download();
    const result = await prepareRuntimeSources({ destinationDirectory });
    expect(result).toEqual(index());
    expect(await readFile(path.join(destinationDirectory, result.files[0]!.file), "utf8")).toBe(body);
    expect(await prepareRuntimeSources({ destinationDirectory })).toEqual(result);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses corrupt downloads and leaves no source index", async () => {
    const destinationDirectory = await temporary();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("SOURCE FIXTURE")));
    await expect(prepareRuntimeSources({ destinationDirectory })).rejects.toThrow(/digest differs/);
    await expect(readFile(path.join(destinationDirectory, RUNTIME_SOURCE_INDEX))).rejects.toThrow();
    download();
    await expect(prepareRuntimeSources({ destinationDirectory })).resolves.toEqual(index());
  });

  it("does not overwrite a file that appears during download", async () => {
    const destinationDirectory = await temporary();
    const destination = path.join(destinationDirectory, index().files[0]!.file);
    vi.stubGlobal("fetch", vi.fn(async () => {
      await writeFile(destination, "concurrent output");
      return new Response(body);
    }));
    await expect(prepareRuntimeSources({ destinationDirectory })).rejects.toThrow();
    expect(await readFile(destination, "utf8")).toBe("concurrent output");
  });

  it("refuses modified archive bytes and archive or index symlinks", async () => {
    const destinationDirectory = await temporary();
    download();
    await prepareRuntimeSources({ destinationDirectory });
    const archive = path.join(destinationDirectory, index().files[0]!.file);
    await writeFile(archive, "SOURCE FIXTURE");
    await expect(verifyRuntimeSources(destinationDirectory)).rejects.toThrow(/digest differs/);
    await rm(archive);
    await symlink(RUNTIME_SOURCE_INDEX, archive);
    await expect(verifyRuntimeSources(destinationDirectory)).rejects.toThrow(/regular file/);
    await rm(archive);
    await writeFile(archive, body);
    await rm(path.join(destinationDirectory, RUNTIME_SOURCE_INDEX));
    await symlink(index().files[0]!.file, path.join(destinationDirectory, RUNTIME_SOURCE_INDEX));
    await expect(verifyRuntimeSources(destinationDirectory)).rejects.toThrow(/bounded regular file/);
  });

  it("admits only specifically named additional release files", async () => {
    const destinationDirectory = await temporary();
    download();
    await prepareRuntimeSources({ destinationDirectory });
    await writeFile(path.join(destinationDirectory, "sources.json"), "{}");
    await expect(verifyRuntimeSources(destinationDirectory)).rejects.toThrow(/unexpected/);
    await expect(verifyRuntimeSources(destinationDirectory, { allowedAdditionalFiles: ["sources.json"] }))
      .resolves.toEqual(index());
    await expect(verifyRuntimeSources(destinationDirectory, { allowedAdditionalFiles: ["../private"] }))
      .rejects.toThrow(/unsafe/);
  });

  it("pins the complete index and rejects substitution or traversal", () => {
    expect(decodeRuntimeSourceIndex(index())).toEqual(index());
    for (const replacement of [
      { revision: "b".repeat(40) },
      { sourceUrl: "https://example.invalid/replacement" },
      { sha256: "b".repeat(64) },
      { bytes: 1 },
      { file: "../private" },
      { extra: true },
    ]) {
      expect(() => decodeRuntimeSourceIndex({ ...index(), files: [{ ...index().files[0], ...replacement }] }))
        .toThrow();
    }
    expect(() => decodeRuntimeSourceIndex({ ...index(), files: [] })).toThrow(/pinned/);
  });
});
