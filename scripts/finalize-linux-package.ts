import { access, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));

const requireSafeSegment = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0 || /[\\/\0]/u.test(value)) {
    throw new Error(`invalid Linux artifact ${label}`);
  }
  return value;
};

const requireReleaseDirectory = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error("invalid Linux artifact release directory");
  }
  return path.resolve(value);
};

export const linuxUnpackedArtifactName = ({
  productName,
  version,
  arch,
}: {
  readonly productName: unknown;
  readonly version: unknown;
  readonly arch: unknown;
}): string =>
  `${requireSafeSegment(productName, "product name")}-${requireSafeSegment(version, "version")}-${requireSafeSegment(arch, "architecture")}-linux.unpacked`;

export const linuxDebArtifactName = ({
  productName,
  version,
  arch,
}: {
  readonly productName: unknown;
  readonly version: unknown;
  readonly arch: unknown;
}): string =>
  `${requireSafeSegment(productName, "product name")}-${requireSafeSegment(version, "version")}-${requireSafeSegment(arch, "architecture")}-linux.deb`;

export const finalizeLinuxUnpackedArtifact = async ({
  releaseDirectory,
  productName,
  version,
  arch,
}: {
  readonly releaseDirectory: unknown;
  readonly productName: unknown;
  readonly version: unknown;
  readonly arch: unknown;
}): Promise<{
  readonly artifact: string;
  readonly deb: string;
  readonly manifest: string;
  readonly artifactName: string;
}> => {
  const release = requireReleaseDirectory(releaseDirectory);
  const artifactName = linuxUnpackedArtifactName({ productName, version, arch });
  const debArtifactName = linuxDebArtifactName({ productName, version, arch });
  const source = path.join(release, "linux-unpacked");
  const artifact = path.join(release, artifactName);
  const debArtifact = path.join(release, debArtifactName);
  if (arch !== "x64") {
    throw new Error(`Linux v1 artifacts require x64, got ${String(arch)}`);
  }
  await access(debArtifact);
  await access(source);
  try {
    await access(artifact);
    throw new Error(`Linux unpacked artifact already exists: ${artifact}`);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      // Expected: electron-builder's generic directory is renamed exactly once.
    } else if (error instanceof Error && error.message.startsWith("Linux unpacked artifact already exists:")) {
      throw error;
    } else {
      throw error;
    }
  }
  await rename(source, artifact);
  const manifest = path.join(release, `${artifactName}.manifest.json`);
  await writeFile(
    manifest,
    `${JSON.stringify({
      productName,
      version,
      arch,
      os: "linux",
      artifact: artifactName,
      deb: debArtifactName,
      support: { distribution: "ubuntu", version: "24.04", libc: "glibc" },
    }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o644 },
  );
  return { artifact, deb: debArtifact, manifest, artifactName };
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--release-dir") {
    throw new Error("usage: finalize-linux-package.ts --release-dir <directory>");
  }
  const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
    readonly version?: unknown;
    readonly build?: { readonly productName?: unknown };
  };
  const result = await finalizeLinuxUnpackedArtifact({
    releaseDirectory: args[1],
    productName: packageJson.build?.productName,
    version: packageJson.version,
    arch: process.arch,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
