import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../scripts/prepare-runtime-sources", () => ({
  RUNTIME_SOURCE_MATERIALS: [],
  RUNTIME_ELECTRON_VERSION: "43.2.0",
  verifyRuntimeSources: async () => ({
    bunVersion: "1.3.13",
    files: [{ file: "bun-source.tar.gz" }],
  }),
}));
import {
  decodeReleaseSources,
  fingerprintSourceFile,
  prepareReleaseSources,
  verifyReleaseSources,
  relinkSourceNames,
  assertPackagedCliCorresponds,
  prepareSourceDownload,
  verifySourceDownload,
  assertLinuxArchiveContainsRuntime,
} from "../scripts/prepare-release-sources";
const roots: string[] = [];
const temporary = () => {
  const root = mkdtempSync(path.join(tmpdir(), "junto-source-test-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const fixture = async () => {
  const root = temporary();
  const sourceCommit = "a".repeat(40);
  const appArchive = `Junto-0.2.1-${sourceCommit}-source.tar.gz`;
  for (const file of [
    appArchive,
    "runtime-sources.json",
    "bun-source.tar.gz",
    "binary.zip",
    ...relinkSourceNames("0.2.1"),
  ])
    writeFileSync(path.join(root, file), `fixture ${file}`);
  writeFileSync(
    path.join(root, "Junto-0.2.1-cli-relink.json"),
    JSON.stringify({
      schema: "junto/cli-relink/v1",
      sourceCommit,
      bunVersion: "1.3.13",
      featureProfile: "ship",
      featureFingerprint: "fixture",
      payload: await fingerprintSourceFile(root, "Junto-0.2.1-cli.js"),
      notices: await fingerprintSourceFile(
        root,
        "Junto-0.2.1-cli-notices.txt",
      ),
    }),
  );
  const files = await Promise.all(
    [
      appArchive,
      "runtime-sources.json",
      "bun-source.tar.gz",
      ...relinkSourceNames("0.2.1"),
    ].map((file) => fingerprintSourceFile(root, file)),
  );
  const binaries = [await fingerprintSourceFile(root, "binary.zip")];
  const index = {
    schema: "junto/release-sources/v1",
    product: "Junto",
    version: "0.2.1",
    sourceCommit,
    access: "same-download-location",
    files,
    binaries,
  };
  const indexPath = path.join(root, "sources.json");
  writeFileSync(indexPath, JSON.stringify(index));
  return {
    root,
    index,
    indexPath,
    binaryPaths: [path.join(root, "binary.zip")],
  };
};

describe("corresponding-source release inventory", () => {
  it("binds a Linux archive to the exact packaged app and relink CLI", async () => {
    const root = temporary();
    const name = "junto-runtime-0.2.1-linux-x64";
    const runtimeRoot = path.join(root, name);
    mkdirSync(path.join(runtimeRoot, "resources/bin"), { recursive: true });
    writeFileSync(path.join(runtimeRoot, "resources/app.asar"), "verified app");
    writeFileSync(path.join(runtimeRoot, "resources/bin/junto"), "verified CLI");
    const archivePath = path.join(root, `${name}.tar.gz`);
    execFileSync("/usr/bin/tar", [...(process.platform === "linux" ? ["--owner=1000", "--group=1000"] : ["--uid", "1000", "--gid", "1000"]), "-czf", archivePath, "-C", root, name]);
    await expect(assertLinuxArchiveContainsRuntime({ archivePath, runtimeRoot, version: "0.2.1" })).resolves.toBeUndefined();
    writeFileSync(path.join(runtimeRoot, "resources/bin/junto"), "changed CLI");
    await expect(assertLinuxArchiveContainsRuntime({ archivePath, runtimeRoot, version: "0.2.1" })).rejects.toThrow(/verified runtime file/);
    await expect(assertLinuxArchiveContainsRuntime({ archivePath, runtimeRoot, version: "0.2.2" })).rejects.toThrow(/canonical archive name/);
  });
  it("admits complete hash-bound material and places its index last", async () => {
    const input = await fixture();
    const result = await verifyReleaseSources({ ...input, version: "0.2.1" });
    expect(result.assets.at(-1)?.file).toBe("sources.json");
    expect(result.assets).toHaveLength(8);
  });
  it("refuses missing source archives, changed bytes, and symlinks", async () => {
    const input = await fixture();
    const material = path.join(input.root, "bun-source.tar.gz");
    writeFileSync(material, "changed");
    await expect(
      verifyReleaseSources({ ...input, version: "0.2.1" }),
    ).rejects.toThrow(/digest differs/);
    rmSync(material);
    await expect(
      verifyReleaseSources({ ...input, version: "0.2.1" }),
    ).rejects.toThrow();
    symlinkSync(path.join(input.root, "binary.zip"), material);
    await expect(
      verifyReleaseSources({ ...input, version: "0.2.1" }),
    ).rejects.toThrow(/regular file/);
  });
  it("refuses incomplete indices and changed post-notary binary bytes", async () => {
    const input = await fixture();
    writeFileSync(
      input.indexPath,
      JSON.stringify({ ...input.index, files: input.index.files.slice(1) }),
    );
    await expect(
      verifyReleaseSources({ ...input, version: "0.2.1" }),
    ).rejects.toThrow(/missing exact/);
    writeFileSync(input.indexPath, JSON.stringify(input.index));
    writeFileSync(input.binaryPaths[0]!, "stapled-new-bytes");
    await expect(
      verifyReleaseSources({ ...input, version: "0.2.1" }),
    ).rejects.toThrow(/digest differs/);
  });
  it("refuses unbound pre-notary preparation and path traversal", async () => {
    const input = await fixture();
    writeFileSync(
      input.indexPath,
      JSON.stringify({ ...input.index, binaries: [] }),
    );
    await expect(
      verifyReleaseSources({ ...input, version: "0.2.1" }),
    ).rejects.toThrow(/lacks exact release binary bindings/);
    expect(() =>
      decodeReleaseSources({
        ...input.index,
        files: [{ file: "../private", bytes: 1, sha256: "a".repeat(64) }],
      }),
    ).toThrow(/invalid source index file/);
    await expect(
      verifyReleaseSources({ ...input, version: "0.2.2" }),
    ).rejects.toThrow(/version/);
  });
  it("streams bounded source parts and rejects changed reconstruction", async () => {
    const root = temporary();
    writeFileSync(
      path.join(root, "source.tar.gz"),
      "exact-source-archive-data",
    );
    const original = await fingerprintSourceFile(root, "source.tar.gz");
    const source = await prepareSourceDownload(root, original, 8);
    expect(source.parts?.map((part) => part.bytes)).toEqual([8, 8, 8, 1]);
    await expect(verifySourceDownload(root, source)).resolves.toHaveLength(4);
    writeFileSync(path.join(root, source.parts![1]!.file), "tampered");
    await expect(verifySourceDownload(root, source)).rejects.toThrow(
      /digest differs/,
    );
  });

  it.skipIf(process.platform !== "darwin")(
    "admits changed Mach-O signature allocation but rejects changed executable content",
    async () => {
      const root = temporary();
      const original = path.join(root, "original");
      const signed = path.join(root, "signed");
      execFileSync("cc", ["-x", "c", "-o", original, "-"], {
        input: "int main(void) { return 0; }",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const entitlements = path.join(root, "entitlements.plist");
      writeFileSync(
        entitlements,
        `<?xml version="1.0"?><plist version="1.0"><dict><key>fixture</key><string>${"x".repeat(100_000)}</string></dict></plist>`,
      );
      execFileSync(
        "codesign",
        ["--force", "--sign", "-", "--entitlements", entitlements, original],
        { stdio: "pipe" },
      );
      copyFileSync(original, signed);
      execFileSync(
        "codesign",
        [
          "--force",
          "--sign",
          "-",
          "--options",
          "runtime",
          "--identifier",
          "org.example.changed-signature",
          signed,
        ],
        { stdio: "pipe" },
      );
      const originalBytes = readFileSync(original);
      const signedBytes = readFileSync(signed);
      expect(originalBytes.length).not.toBe(signedBytes.length);
      await expect(
        assertPackagedCliCorresponds(original, signed),
      ).resolves.toBeUndefined();
      expect(readFileSync(original)).toEqual(originalBytes);
      expect(readFileSync(signed)).toEqual(signedBytes);
      execFileSync("cc", ["-x", "c", "-o", signed, "-"], {
        input: "int main(void) { return 1; }",
        stdio: ["pipe", "pipe", "pipe"],
      });
      await expect(
        assertPackagedCliCorresponds(original, signed),
      ).rejects.toThrow(/content differs/);
    },
  );

  it("archives exact clean tracked source reproducibly without Git history or untracked files", async () => {
    const root = temporary();
    const runtimeSources = path.join(root, "runtime-input");
    const releaseDirectory = path.join(root, "release");
    mkdirSync(runtimeSources);
    mkdirSync(path.join(root, "node_modules/electron"), { recursive: true });
    writeFileSync(
      path.join(root, "node_modules/electron/package.json"),
      JSON.stringify({ version: "43.2.0" }),
    );
    writeFileSync(path.join(runtimeSources, "runtime-sources.json"), "{}");
    writeFileSync(
      path.join(runtimeSources, "bun-source.tar.gz"),
      "upstream fixture",
    );
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ version: "0.2.1", packageManager: "bun@1.3.13" }),
    );
    writeFileSync(path.join(root, "cli.ts"), "console.log('source');\n");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    writeFileSync(
      path.join(root, ".gitignore"),
      "dist/\nnode_modules/\nruntime-input/\nrelease/\nuntracked-private.txt\n",
    );
    git("init");
    git("add", "package.json", "cli.ts", ".gitignore");
    git(
      "-c",
      "user.name=Example Maintainer",
      "-c",
      "user.email=example@example.invalid",
      "commit",
      "-m",
      "fixture",
    );
    writeFileSync(path.join(root, "untracked-private.txt"), "not source");
    const dist = path.join(root, "dist");
    mkdirSync(dist);
    for (const file of [
      "junto-relink.js",
      "junto-relink-notices.txt",
      "junto",
    ])
      writeFileSync(path.join(dist, file), `fixture ${file}`);
    writeFileSync(
      path.join(dist, "junto-relink.json"),
      JSON.stringify({
        schema: "junto/cli-relink/v1",
        sourceCommit: git("rev-parse", "HEAD").trim(),
        bunVersion: "1.3.13",
        featureProfile: "ship",
        featureFingerprint: "fixture",
        payload: await fingerprintSourceFile(dist, "junto-relink.js"),
        notices: await fingerprintSourceFile(
          dist,
          "junto-relink-notices.txt",
        ),
        binary: await fingerprintSourceFile(dist, "junto"),
      }),
    );
    const first = await prepareReleaseSources({
      repoRoot: root,
      runtimeSources,
      releaseDirectory,
    });
    const second = await prepareReleaseSources({
      repoRoot: root,
      runtimeSources,
      releaseDirectory,
    });
    expect(second).toEqual(first);
    const archive = first.files.find((file) =>
      file.file.includes(first.sourceCommit),
    )!;
    const file = path.join(releaseDirectory, "sources", archive.file);
    expect(createHash("sha256").update(readFileSync(file)).digest("hex")).toBe(
      archive.sha256,
    );
    expect(execFileSync("tar", ["-tzf", file], { encoding: "utf8" })).toBe(
      "Junto-0.2.1/\nJunto-0.2.1/.gitignore\nJunto-0.2.1/cli.ts\nJunto-0.2.1/package.json\n",
    );
    writeFileSync(path.join(root, "cli.ts"), "dirty\n");
    await expect(
      prepareReleaseSources({
        repoRoot: root,
        runtimeSources,
        releaseDirectory,
      }),
    ).rejects.toThrow();
  });
});
