import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, chmod, lstat, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));

const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

const requireSemver = (value: unknown): string => {
  if (typeof value !== "string" || !SEMVER.test(value)) throw new Error("invalid Linux runtime version");
  return value;
};

export const linuxRuntimeArtifactName = ({ version, arch }: { readonly version: unknown; readonly arch: unknown }): string => {
  const resolvedArch = arch;
  if (resolvedArch !== "x64") throw new Error(`Linux runtime requires x64, got ${resolvedArch}`);
  return `vellum-runtime-${requireSemver(version)}-linux-${resolvedArch}`;
};

export const linuxRuntimeArchiveName = (input: { readonly version: unknown; readonly arch: unknown }): string =>
  `${linuxRuntimeArtifactName(input)}.tar.gz`;

export const linuxRuntimeTarArguments = (platform: NodeJS.Platform): ReadonlyArray<string> =>
  platform === "linux"
    ? ["--sort=name", "--mtime=@0", "--format=gnu", "--numeric-owner", "--owner=1000", "--group=1000"]
    : [];

export const validateLinuxRuntimeArchive = ({ archive, artifactName }: { readonly archive: string; readonly artifactName: string }): void => {
  const result = spawnSync("/usr/bin/tar", ["--list", "--verbose", "--gzip", "--file", archive], { encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(`tar archive inspection failed: ${result.stderr.trim()}`);
  const lines = result.stdout.trimEnd().split("\n").filter(Boolean);
  if (lines.length === 0) throw new Error("runtime archive is empty");
  let rootDirectory = false;
  for (const line of lines) {
    const type = line[0];
    if (type !== "-" && type !== "d") throw new Error("runtime archive contains a link or special entry");
    const fields = line.trim().split(/\s+/u);
    const entry = fields.at(-1);
    if (entry === undefined || entry.startsWith("/") || entry.includes("//") || entry.split("/").some((part) => part === ".." || part === ".")) throw new Error("runtime archive contains an unsafe path");
    const isRoot = entry === artifactName || entry === `${artifactName}/`;
    if (!isRoot && !entry.startsWith(`${artifactName}/`)) throw new Error("runtime archive has an unexpected root");
    if (isRoot && type === "d") rootDirectory = true;
    if (/\b(?:root\/root|0\/0)\b/u.test(line)) throw new Error("runtime archive records root ownership");
  }
  if (!rootDirectory) throw new Error("runtime archive has no root directory");
};

const executableNames = new Set([
  "vellum-command",
  "resources/bin/vellum-command",
  "resources/bin/vellum-command-remote",
  "resources/bin/node",
  "resources/bin/unix-peer-pid.py",
  "resources/systemd/vellum-command-remote-launch",
]);

const normalizeModes = async (root: string, relative = ""): Promise<void> => {
  const directory = path.join(root, relative);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const childRelative = path.posix.join(relative, entry.name);
    const child = path.join(root, childRelative);
    const metadata = await lstat(child);
    if (metadata.isSymbolicLink()) throw new Error(`runtime tree contains a symlink: ${childRelative}`);
    if (metadata.isDirectory()) {
      await chmod(child, 0o755);
      await normalizeModes(root, childRelative);
    } else if (metadata.isFile()) {
      const executable =
        executableNames.has(childRelative) ||
        childRelative.endsWith(".node") ||
        childRelative.endsWith("/spawn-helper") ||
        childRelative === "spawn-helper";
      await chmod(child, executable ? 0o755 : 0o644);
    } else {
      throw new Error(`runtime tree contains unsupported entry: ${childRelative}`);
    }
  }
};

const sha256File = async (file: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};

export const finalizeLinuxRuntimeArtifact = async ({ releaseDirectory, version, arch }: {
  readonly releaseDirectory: string;
  readonly version: unknown;
  readonly arch: unknown;
}): Promise<{ readonly artifact: string; readonly archive: string; readonly manifest: string; readonly digest: string }> => {
  const release = path.resolve(releaseDirectory);
  const artifactName = linuxRuntimeArtifactName({ version, arch });
  const source = path.join(release, "linux-unpacked");
  const artifact = path.join(release, artifactName);
  const archive = path.join(release, linuxRuntimeArchiveName({ version, arch }));
  const manifest = path.join(release, `${artifactName}.manifest.json`);
  await access(source);
  const sourceMetadata = await lstat(source);
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    throw new Error("Linux runtime source must be a non-symlink directory");
  }
  for (const candidate of [artifact, archive, manifest]) {
    await stat(candidate).then(() => { throw new Error(`runtime artifact already exists: ${candidate}`); }, (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
  await rename(source, artifact);
  await chmod(artifact, 0o755);
  await normalizeModes(artifact);
  // Linux is the only supported builder. Numeric archive metadata is portable
  // across builders and cannot require an account named after the product.
  const reproducibleArguments = linuxRuntimeTarArguments(process.platform);
  const tar = spawnSync("/usr/bin/tar", ["--create", "--gzip", "--file", archive, ...reproducibleArguments, artifactName], { cwd: release, encoding: "utf8", shell: false });
  if (tar.status !== 0) throw new Error(`tar archive creation failed: ${tar.stderr.trim()}`);
  validateLinuxRuntimeArchive({ archive, artifactName });
  const digest = await sha256File(archive);
  await writeFile(manifest, `${JSON.stringify({ schema: "vellum/linux-userland-runtime/v1", version, arch: "x64", artifact: artifactName, archive: path.basename(archive), sha256: digest }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o644 });
  return { artifact, archive, manifest, digest };
};

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  const [flag, releaseDirectory] = process.argv.slice(2);
  if (flag !== "--release-dir" || releaseDirectory === undefined || process.argv.length !== 4) throw new Error("usage: finalize-linux-package.ts --release-dir <directory>");
  const pkg = JSON.parse(await readFile(packagePath, "utf8")) as { version?: unknown };
  process.stdout.write(`${JSON.stringify(await finalizeLinuxRuntimeArtifact({ releaseDirectory, version: pkg.version, arch: "x64" }))}\n`);
}
