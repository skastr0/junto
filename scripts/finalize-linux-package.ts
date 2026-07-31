import { access, chmod, lstat, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));

const safeSegment = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0 || /[\\/\0]/u.test(value)) {
    throw new Error(`invalid Linux runtime ${label}`);
  }
  return value;
};

export const linuxRuntimeArtifactName = ({ version, arch }: { readonly version: unknown; readonly arch: unknown }): string => {
  const resolvedArch = safeSegment(arch, "architecture");
  if (resolvedArch !== "x64") throw new Error(`Linux runtime requires x64, got ${resolvedArch}`);
  return `vellum-runtime-${safeSegment(version, "version")}-linux-${resolvedArch}`;
};

export const linuxRuntimeArchiveName = (input: { readonly version: unknown; readonly arch: unknown }): string =>
  `${linuxRuntimeArtifactName(input)}.tar.gz`;

export const validateLinuxRuntimeArchive = ({ archive, artifactName }: { readonly archive: string; readonly artifactName: string }): void => {
  const result = spawnSync("/usr/bin/tar", ["--list", "--verbose", "--gzip", "--file", archive], { encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(`tar archive inspection failed: ${result.stderr.trim()}`);
  const lines = result.stdout.trimEnd().split("\n");
  if (lines.length === 0 || lines.some((line) => !line.endsWith(` ${artifactName}/`) && !line.includes(` ${artifactName}/`))) throw new Error("runtime archive has an unexpected root");
  if (lines.some((line) => /\broot\/root\b/u.test(line))) throw new Error("runtime archive records root ownership");
};

const executableNames = new Set([
  "vellum",
  "resources/bin/vellum",
  "resources/bin/vellum-browser",
  "resources/bin/vellum-station",
  "resources/bin/unix-peer-pid.py",
  "resources/systemd/vellum-remote-launch",
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
      await chmod(child, executableNames.has(childRelative) || childRelative.endsWith(".node") ? 0o755 : 0o644);
    } else {
      throw new Error(`runtime tree contains unsupported entry: ${childRelative}`);
    }
  }
};

const sha256 = async (value: Uint8Array): Promise<string> =>
  Buffer.from(await crypto.subtle.digest("SHA-256", value as unknown as BufferSource)).toString("hex");

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
  for (const candidate of [artifact, archive, manifest]) {
    await stat(candidate).then(() => { throw new Error(`runtime artifact already exists: ${candidate}`); }, (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
  await rename(source, artifact);
  await chmod(artifact, 0o755);
  await normalizeModes(artifact);
  // Archive ownership is deliberately non-root metadata. Extraction as the
  // operator produces an operator-owned release without package-manager help.
  const tar = spawnSync("/usr/bin/tar", ["--create", "--gzip", "--file", archive, "--owner=vellum", "--group=vellum", artifactName], { cwd: release, encoding: "utf8", shell: false });
  if (tar.status !== 0) throw new Error(`tar archive creation failed: ${tar.stderr.trim()}`);
  validateLinuxRuntimeArchive({ archive, artifactName });
  const digest = await sha256(await readFile(archive));
  await writeFile(manifest, `${JSON.stringify({ schema: "vellum/linux-userland-runtime/v1", version, arch: "x64", artifact: artifactName, archive: path.basename(archive), sha256: digest }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o644 });
  return { artifact, archive, manifest, digest };
};

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  const [flag, releaseDirectory] = process.argv.slice(2);
  if (flag !== "--release-dir" || releaseDirectory === undefined || process.argv.length !== 4) throw new Error("usage: finalize-linux-package.ts --release-dir <directory>");
  const pkg = JSON.parse(await readFile(packagePath, "utf8")) as { version?: unknown };
  process.stdout.write(`${JSON.stringify(await finalizeLinuxRuntimeArtifact({ releaseDirectory, version: pkg.version, arch: "x64" }))}\n`);
}
