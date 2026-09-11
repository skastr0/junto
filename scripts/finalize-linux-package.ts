import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  link,
} from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));

const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const ATTEMPT_NAME = /^\.vellum-package-attempt-[0-9A-Za-z._-]+$/u;

const requireSemver = (value: unknown): string => {
  if (typeof value !== "string" || !SEMVER.test(value)) {
    throw new Error("invalid Linux runtime version");
  }
  return value;
};

export const linuxRuntimeArtifactName = ({
  version,
  arch,
}: {
  readonly version: unknown;
  readonly arch: unknown;
}): string => {
  const resolvedArch = arch;
  if (resolvedArch !== "x64") {
    throw new Error(`Linux runtime requires x64, got ${String(resolvedArch)}`);
  }
  return `vellum-command-runtime-${requireSemver(version)}-linux-${resolvedArch}`;
};

export const linuxRuntimeArchiveName = (input: {
  readonly version: unknown;
  readonly arch: unknown;
}): string => `${linuxRuntimeArtifactName(input)}.tar.gz`;

export const linuxRuntimeTarArguments = (
  platform: NodeJS.Platform,
): ReadonlyArray<string> =>
  platform === "linux"
    ? [
        "--sort=name",
        "--mtime=@0",
        "--format=gnu",
        "--numeric-owner",
        "--owner=1000",
        "--group=1000",
      ]
    : [];

export const validateLinuxRuntimeArchive = ({
  archive,
  artifactName,
}: {
  readonly archive: string;
  readonly artifactName: string;
}): void => {
  const result = spawnSync(
    "/usr/bin/tar",
    ["--list", "--verbose", "--gzip", "--file", archive],
    { encoding: "utf8", shell: false },
  );
  if (result.status !== 0) {
    throw new Error(`tar archive inspection failed: ${result.stderr.trim()}`);
  }
  const lines = result.stdout.trimEnd().split("\n").filter(Boolean);
  if (lines.length === 0) throw new Error("runtime archive is empty");
  let rootDirectory = false;
  for (const line of lines) {
    const type = line[0];
    if (type !== "-" && type !== "d") {
      throw new Error("runtime archive contains a link or special entry");
    }
    const fields = line.trim().split(/\s+/u);
    const entry = fields.at(-1);
    const pathForSegments = entry?.endsWith("/") ? entry.slice(0, -1) : entry;
    if (
      entry === undefined ||
      pathForSegments === undefined ||
      pathForSegments.length === 0 ||
      entry.startsWith("/") ||
      entry.includes("//") ||
      pathForSegments
        .split("/")
        .some((part) => part === ".." || part === "." || part.length === 0)
    ) {
      throw new Error("runtime archive contains an unsafe path");
    }
    const isRoot = entry === artifactName || entry === `${artifactName}/`;
    if (!isRoot && !entry.startsWith(`${artifactName}/`)) {
      throw new Error("runtime archive has an unexpected root");
    }
    if (isRoot && type === "d") rootDirectory = true;
    if (/\b(?:root\/root|0\/0)\b/u.test(line)) {
      throw new Error("runtime archive records root ownership");
    }
  }
  if (!rootDirectory) {
    throw new Error("runtime archive has no root directory");
  }
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
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const childRelative = path.posix.join(relative, entry.name);
    const child = path.join(root, childRelative);
    const metadata = await lstat(child);
    if (metadata.isSymbolicLink()) {
      throw new Error(`runtime tree contains a symlink: ${childRelative}`);
    }
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

const lstatIfPresent = async (candidate: string) => {
  try {
    return await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

export const assertPackageDestinationAbsent = async (
  candidate: string,
): Promise<void> => {
  if ((await lstatIfPresent(candidate)) !== undefined) {
    throw new Error(`package destination already exists: ${candidate}`);
  }
};

const requireCanonicalDirectory = async (
  directory: string,
  label: string,
): Promise<string> => {
  const resolved = path.resolve(directory);
  const metadata = await lstatIfPresent(resolved);
  if (
    metadata === undefined ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink()
  ) {
    throw new Error(`${label} must be a non-symlink directory: ${resolved}`);
  }
  return resolved;
};

const requireOwnedAttemptDirectory = async (
  attemptDirectory: string,
  releaseDirectory?: string,
): Promise<string> => {
  const attempt = await requireCanonicalDirectory(
    attemptDirectory,
    "package attempt directory",
  );
  if (!ATTEMPT_NAME.test(path.basename(attempt))) {
    throw new Error("package attempt directory has no owned attempt name");
  }
  if (releaseDirectory !== undefined) {
    const release = await requireCanonicalDirectory(
      releaseDirectory,
      "release directory",
    );
    if (path.dirname(attempt) !== release) {
      throw new Error("package attempt must be a direct child of release");
    }
  }
  return attempt;
};

const createExclusiveRegularFile = async (file: string) => {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(
    file,
    fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_WRONLY |
      noFollow,
    0o600,
  );
  const metadata = await handle.stat();
  if (!metadata.isFile() || metadata.nlink !== 1) {
    await handle.close();
    throw new Error(`attempt output is not an exclusive regular file: ${file}`);
  }
  return handle;
};

export type LinuxRuntimeDraft = {
  readonly artifact: string;
  readonly archive: string;
  readonly manifest: string;
  readonly digest: string;
  readonly artifactName: string;
};

/**
 * Convert attempt-owned linux-unpacked into an audited-candidate tree/archive.
 * Every byte stays under the 0700 attempt directory. This does not publish.
 */
export const createLinuxRuntimeDraft = async ({
  attemptDirectory,
  version,
  arch,
}: {
  readonly attemptDirectory: string;
  readonly version: unknown;
  readonly arch: unknown;
}): Promise<LinuxRuntimeDraft> => {
  const attempt = await requireOwnedAttemptDirectory(attemptDirectory);
  const artifactName = linuxRuntimeArtifactName({ version, arch });
  const source = path.join(attempt, "linux-unpacked");
  const artifact = path.join(attempt, artifactName);
  const archive = path.join(attempt, linuxRuntimeArchiveName({ version, arch }));
  const manifest = path.join(attempt, `${artifactName}.manifest.json`);

  const sourceMetadata = await lstatIfPresent(source);
  if (
    sourceMetadata === undefined ||
    !sourceMetadata.isDirectory() ||
    sourceMetadata.isSymbolicLink()
  ) {
    throw new Error("Linux runtime source must be a non-symlink directory");
  }
  for (const candidate of [artifact, archive, manifest]) {
    await assertPackageDestinationAbsent(candidate);
  }

  await rename(source, artifact);
  await chmod(artifact, 0o755);
  await normalizeModes(artifact);

  const archiveHandle = await createExclusiveRegularFile(archive);
  try {
    const tar = spawnSync(
      "/usr/bin/tar",
      [
        "--create",
        "--gzip",
        "--file=-",
        ...linuxRuntimeTarArguments(process.platform),
        artifactName,
      ],
      {
        cwd: attempt,
        encoding: "utf8",
        shell: false,
        stdio: ["ignore", archiveHandle.fd, "pipe"],
      },
    );
    if (tar.status !== 0) {
      throw new Error(`tar archive creation failed: ${tar.stderr.trim()}`);
    }
    await archiveHandle.sync();
    const archiveMetadata = await archiveHandle.stat();
    if (!archiveMetadata.isFile() || archiveMetadata.nlink !== 1) {
      throw new Error("attempt archive changed identity during creation");
    }
  } finally {
    await archiveHandle.close();
  }
  await chmod(archive, 0o644);
  const admittedArchive = await lstat(archive);
  if (
    !admittedArchive.isFile() ||
    admittedArchive.isSymbolicLink() ||
    admittedArchive.nlink !== 1
  ) {
    throw new Error("attempt archive is not a private regular file");
  }
  validateLinuxRuntimeArchive({ archive, artifactName });
  const digest = await sha256File(archive);

  const manifestHandle = await createExclusiveRegularFile(manifest);
  try {
    await manifestHandle.writeFile(
      `${JSON.stringify(
        {
          schema: "vellum/linux-userland-runtime/v1",
          version,
          arch: "x64",
          artifact: artifactName,
          archive: path.basename(archive),
          sha256: digest,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8" },
    );
    await manifestHandle.sync();
  } finally {
    await manifestHandle.close();
  }
  await chmod(manifest, 0o644);
  return { artifact, archive, manifest, digest, artifactName };
};

const publishRegularFileExclusive = async (
  draft: string,
  destination: string,
): Promise<void> => {
  const before = await lstat(draft);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1
  ) {
    throw new Error(`draft output must be an exclusive regular file: ${draft}`);
  }
  // link(2) is the portable no-clobber publication primitive for a same-volume
  // regular file. It returns EEXIST for every existing leaf, including a
  // dangling symlink, and never follows the destination.
  await link(draft, destination);
  const published = await lstat(destination);
  if (
    !published.isFile() ||
    published.isSymbolicLink() ||
    published.dev !== before.dev ||
    published.ino !== before.ino
  ) {
    throw new Error(`published file did not retain draft identity: ${destination}`);
  }
  await unlink(draft);
};

const publishDirectoryVerified = async (
  draft: string,
  destination: string,
): Promise<void> => {
  const before = await lstat(draft);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`draft output must be a non-symlink directory: ${draft}`);
  }
  await rename(draft, destination);
  const published = await lstat(destination);
  if (
    !published.isDirectory() ||
    published.isSymbolicLink() ||
    published.dev !== before.dev ||
    published.ino !== before.ino
  ) {
    throw new Error(`published directory did not retain draft identity: ${destination}`);
  }
};

export type PublishedPackageAttempt = {
  readonly published: ReadonlyArray<string>;
};

/** Publish every audited top-level draft with no-clobber destination checks. */
export const publishPackageAttempt = async (input: {
  readonly attemptDirectory: string;
  readonly releaseDirectory: string;
}): Promise<PublishedPackageAttempt> => {
  const release = await requireCanonicalDirectory(
    input.releaseDirectory,
    "release directory",
  );
  const attempt = await requireOwnedAttemptDirectory(
    input.attemptDirectory,
    release,
  );
  const entries = await readdir(attempt, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length === 0) throw new Error("package attempt has no outputs");
  for (const entry of entries) {
    if (
      entry.name.length === 0 ||
      entry.name === "." ||
      entry.name === ".." ||
      entry.name.includes("/") ||
      entry.name.includes("\\") ||
      entry.name.includes("\0")
    ) {
      throw new Error("package attempt contains an unsafe output name");
    }
    const draft = path.join(attempt, entry.name);
    const metadata = await lstat(draft);
    if (
      metadata.isSymbolicLink() ||
      (!metadata.isFile() && !metadata.isDirectory())
    ) {
      throw new Error(`package attempt contains unsupported output: ${entry.name}`);
    }
    await assertPackageDestinationAbsent(path.join(release, entry.name));
  }

  const published: string[] = [];
  for (const entry of entries) {
    const draft = path.join(attempt, entry.name);
    const destination = path.join(release, entry.name);
    if (entry.isDirectory()) {
      await publishDirectoryVerified(draft, destination);
    } else {
      await publishRegularFileExclusive(draft, destination);
    }
    published.push(destination);
  }
  await rmdir(attempt);
  return { published };
};

/** Compatibility helper used by focused tests; production uses draft + audit + publish. */
export const finalizeLinuxRuntimeArtifact = async ({
  releaseDirectory,
  version,
  arch,
}: {
  readonly releaseDirectory: string;
  readonly version: unknown;
  readonly arch: unknown;
}): Promise<{
  readonly artifact: string;
  readonly archive: string;
  readonly manifest: string;
  readonly digest: string;
}> => {
  const release = await requireCanonicalDirectory(
    releaseDirectory,
    "release directory",
  );
  const artifactName = linuxRuntimeArtifactName({ version, arch });
  const finals = [
    path.join(release, artifactName),
    path.join(release, linuxRuntimeArchiveName({ version, arch })),
    path.join(release, `${artifactName}.manifest.json`),
  ];
  for (const candidate of finals) await assertPackageDestinationAbsent(candidate);

  const attempt = await mkdtemp(path.join(release, ".vellum-package-attempt-"));
  await chmod(attempt, 0o700);
  const source = path.join(release, "linux-unpacked");
  const stagedSource = path.join(attempt, "linux-unpacked");
  let published = false;
  try {
    await rename(source, stagedSource);
    const draft = await createLinuxRuntimeDraft({
      attemptDirectory: attempt,
      version,
      arch,
    });
    await publishPackageAttempt({
      attemptDirectory: attempt,
      releaseDirectory: release,
    });
    published = true;
    return {
      artifact: path.join(release, path.basename(draft.artifact)),
      archive: path.join(release, path.basename(draft.archive)),
      manifest: path.join(release, path.basename(draft.manifest)),
      digest: draft.digest,
    };
  } finally {
    if (!published) {
      const staged = await lstatIfPresent(stagedSource);
      const original = await lstatIfPresent(source);
      if (
        staged?.isDirectory() === true &&
        !staged.isSymbolicLink() &&
        original === undefined
      ) {
        await rename(stagedSource, source);
      }
      await rm(attempt, { recursive: true, force: true });
    }
  }
};

const parsePairs = (args: ReadonlyArray<string>): Map<string, string> => {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--")) {
      throw new Error("options require --name value pairs");
    }
    if (options.has(flag)) throw new Error(`duplicate option: ${flag}`);
    options.set(flag, value);
  }
  return options;
};

const requiredOption = (options: Map<string, string>, name: string): string => {
  const value = options.get(name);
  if (value === undefined || value.length === 0) {
    throw new Error(`missing required option: ${name}`);
  }
  return value;
};

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  const [command, ...args] = process.argv.slice(2);
  const pkg = JSON.parse(await readFile(packagePath, "utf8")) as {
    version?: unknown;
  };
  if (command === "draft") {
    const options = parsePairs(args);
    const result = await createLinuxRuntimeDraft({
      attemptDirectory: requiredOption(options, "--attempt-dir"),
      version: pkg.version,
      arch: "x64",
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (command === "publish-attempt") {
    const options = parsePairs(args);
    const result = await publishPackageAttempt({
      attemptDirectory: requiredOption(options, "--attempt-dir"),
      releaseDirectory: requiredOption(options, "--release-dir"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (command === "--release-dir") {
    const [releaseDirectory] = args;
    if (releaseDirectory === undefined || args.length !== 1) {
      throw new Error(
        "usage: finalize-linux-package.ts --release-dir <directory>",
      );
    }
    const result = await finalizeLinuxRuntimeArtifact({
      releaseDirectory,
      version: pkg.version,
      arch: "x64",
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    throw new Error(
      "usage: finalize-linux-package.ts draft --attempt-dir PATH | publish-attempt --attempt-dir PATH --release-dir PATH | --release-dir PATH",
    );
  }
}
