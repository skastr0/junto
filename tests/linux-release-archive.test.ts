import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LINUX_RELEASE_CHECKSUMS,
  LINUX_RELEASE_MANIFEST,
  LINUX_RELEASE_SIGNATURE,
  LINUX_RELEASE_TARGET,
  linuxUserlandRuntimeArchiveName,
} from "../scripts/linux-release-bundle";
import { createLinuxReleaseArchive } from "../scripts/linux-release-archive";

const roots: string[] = [];
const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Linux release archive", () => {
  it("creates only the exact userland runtime archive name bound by the receipt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vellum-release-archive-"));
    const output = await mkdtemp(path.join(tmpdir(), "vellum-release-archive-output-"));
    roots.push(root, output);
    const version = "1.2.3";
    const packageFile = linuxUserlandRuntimeArchiveName(version);
    const files: Readonly<Record<string, string>> = {
      [packageFile]: "userland runtime bytes",
      [LINUX_RELEASE_MANIFEST]: "manifest",
      [LINUX_RELEASE_SIGNATURE]: "signature",
      [LINUX_RELEASE_CHECKSUMS]: "checksums",
    };
    await Promise.all(Object.entries(files).map(([file, value]) =>
      writeFile(path.join(root, file), value),
    ));
    const receiptPath = path.join(output, "verification.json");
    await writeFile(receiptPath, JSON.stringify({
      schema: "vellum/linux-release-verification-receipt/v1",
      ok: true,
      version,
      sourceRevision: "a".repeat(40),
      target: LINUX_RELEASE_TARGET,
      keyId: "vellum-linux-2026a",
      keyringRevision: 1,
      signedAt: "2026-07-31T00:00:00.000Z",
      expiresAt: "2026-08-01T00:00:00.000Z",
      filesVerified: 1,
      bundleFiles: Object.entries(files).map(([file, value]) => ({
        file,
        bytes: Buffer.byteLength(value),
        sha256: digest(value),
      })),
      packageFile,
      packageBytes: Buffer.byteLength(files[packageFile]!),
      packageSha256: digest(files[packageFile]!),
    }));

    const archivePath = path.join(output, packageFile);
    await expect(createLinuxReleaseArchive({
      bundleDirectory: root,
      verificationReceiptPath: receiptPath,
      archivePath,
    })).resolves.toMatchObject({ archiveFile: packageFile, version });
    await expect(readFile(archivePath)).resolves.not.toHaveLength(0);
    await expect(createLinuxReleaseArchive({
      bundleDirectory: root,
      verificationReceiptPath: receiptPath,
      archivePath: path.join(output, "vellum-1.2.3-ubuntu-24.04-x64-release.tar.gz"),
    })).rejects.toThrow(/must be named vellum-command-runtime-1.2.3-linux-x64\.tar\.gz/u);
  });
});
