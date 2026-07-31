import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  open,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  flipFuses,
  FuseState,
  FuseV1Options,
  FuseVersion,
  getCurrentFuseWire,
} from "@electron/fuses";

const POLICY_PATH = fileURLToPath(
  new URL("./package-security-policy.json", import.meta.url),
);
const ELECTRON_RUNTIME_VERSION_PATH = fileURLToPath(
  new URL("../node_modules/electron/dist/version", import.meta.url),
);
const LINUX_RELEASE_ROOT = fileURLToPath(
  new URL("../release", import.meta.url),
);
const LINUX_ARTIFACT_ROOT = fileURLToPath(
  new URL("../release/linux-unpacked", import.meta.url),
);
const LINUX_FIXED_MODE_DIRECTORIES = [
  "resources",
  "resources/bin",
  "resources/policy",
  "resources/systemd",
];
const LINUX_FIXED_MODE_FILES = new Map([
  ["resources/bin/unix-peer-pid.py", 0o755],
  ["resources/policy/electron-security-policy.json", 0o644],
  ["resources/systemd/vellum-remote-launch-v1", 0o755],
  ["resources/systemd/vellum-remote.service", 0o644],
]);

const libraryFuseNames = () =>
  Object.keys(FuseV1Options)
    .filter((name) => Number.isNaN(Number(name)))
    .sort((left, right) => FuseV1Options[left] - FuseV1Options[right]);

const loadPolicy = async () => {
  const policy = JSON.parse(await readFile(POLICY_PATH, "utf8"));
  if (
    typeof policy !== "object" ||
    policy === null ||
    typeof policy.productName !== "string" ||
    typeof policy.fuses !== "object" ||
    policy.fuses === null
  ) {
    throw new Error("invalid package security policy");
  }

  const expectedNames = libraryFuseNames();
  const configuredNames = Object.keys(policy.fuses).sort(
    (left, right) =>
      expectedNames.indexOf(left) - expectedNames.indexOf(right),
  );
  if (
    configuredNames.length !== expectedNames.length ||
    configuredNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error(
      `package security policy must configure every known Electron fuse exactly once; library=${expectedNames.join(",")} policy=${configuredNames.join(",")}`,
    );
  }
  for (const name of expectedNames) {
    if (typeof policy.fuses[name] !== "boolean") {
      throw new Error(`package security policy fuse ${name} must be boolean`);
    }
  }
  return policy;
};

const assertFuseWire = (wire, policy) => {
  if (wire.version !== FuseVersion.V1) {
    throw new Error(`unexpected Electron fuse version ${wire.version}`);
  }
  const names = libraryFuseNames();
  const wireIndexes = Object.keys(wire)
    .filter((key) => /^\d+$/.test(key))
    .map(Number)
    .sort((left, right) => left - right);
  const expectedIndexes = names.map((name) => FuseV1Options[name]);
  if (
    wireIndexes.length !== expectedIndexes.length ||
    wireIndexes.some((value, index) => value !== expectedIndexes[index])
  ) {
    throw new Error(
      `Electron fuse wire does not exactly match the known fuse set; wire=${wireIndexes.join(",")} expected=${expectedIndexes.join(",")}`,
    );
  }
  for (const name of names) {
    const index = FuseV1Options[name];
    const expected = policy.fuses[name]
      ? FuseState.ENABLE
      : FuseState.DISABLE;
    if (wire[index] !== expected) {
      throw new Error(
        `Electron fuse ${name} mismatch after flip: got ${wire[index]} want ${expected}`,
      );
    }
  }
};

export const isExpectedLinuxArtifactRoot = (candidate) =>
  typeof candidate === "string" &&
  path.resolve(candidate) === LINUX_ARTIFACT_ROOT;

const sameIdentity = (left, right) =>
  left.dev === right.dev && left.ino === right.ino;

const procDescriptorPath = (handle, relativePath = "") =>
  path.posix.join("/proc/self/fd", String(handle.fd), relativePath);

const lstatIfPresent = async (candidate) => {
  try {
    return await lstat(candidate);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
};

const fixedRelativePath = (candidate) => {
  if (
    typeof candidate !== "string" ||
    candidate === "" ||
    path.posix.isAbsolute(candidate) ||
    path.posix.normalize(candidate) !== candidate ||
    candidate === ".." ||
    candidate.startsWith("../")
  ) {
    throw new Error("invalid fixed Linux package artifact path");
  }
  return candidate;
};

const fixedParentHandle = (artifact, relativePath) => {
  const admittedPath = fixedRelativePath(relativePath);
  const parent = path.posix.dirname(admittedPath);
  if (parent === ".") return artifact.root.handle;
  const directory = artifact.fixedDirectories.get(parent);
  if (directory === undefined) {
    throw new Error(
      `Linux package artifact parent is not admitted: ${parent}`,
    );
  }
  return directory.handle;
};

const admitLinuxArtifact = async (candidate) => {
  if (!isExpectedLinuxArtifactRoot(candidate)) {
    throw new Error(
      `Linux package artifact root must be ${LINUX_ARTIFACT_ROOT}`,
    );
  }
  if (
    !Number.isInteger(fsConstants.O_DIRECTORY) ||
    !Number.isInteger(fsConstants.O_NOFOLLOW)
  ) {
    throw new Error("Linux package admission requires no-follow opens");
  }
  const releasePathMetadata = await lstat(LINUX_RELEASE_ROOT);
  if (
    releasePathMetadata.isSymbolicLink() ||
    !releasePathMetadata.isDirectory()
  ) {
    throw new Error(
      "Linux package release root must be a non-symlink directory",
    );
  }
  const releaseHandle = await open(
    LINUX_RELEASE_ROOT,
    fsConstants.O_RDONLY |
      fsConstants.O_DIRECTORY |
      fsConstants.O_NOFOLLOW,
  );
  let rootHandle;
  let executableHandle;
  let chromeSandboxHandle;
  const fixedDirectories = new Map();
  const fixedFiles = new Map();
  try {
    const releaseHandleMetadata = await releaseHandle.stat();
    if (
      !releaseHandleMetadata.isDirectory() ||
      !sameIdentity(releasePathMetadata, releaseHandleMetadata)
    ) {
      throw new Error(
        "Linux package release root identity changed during admission",
      );
    }
    const rootPath = procDescriptorPath(releaseHandle, "linux-unpacked");
    const rootPathMetadata = await lstat(rootPath);
    if (
      rootPathMetadata.isSymbolicLink() ||
      !rootPathMetadata.isDirectory()
    ) {
      throw new Error(
        "Linux package artifact root must be a non-symlink directory",
      );
    }
    rootHandle = await open(
      rootPath,
      fsConstants.O_RDONLY |
        fsConstants.O_DIRECTORY |
        fsConstants.O_NOFOLLOW,
    );
    const rootHandleMetadata = await rootHandle.stat();
    if (
      !rootHandleMetadata.isDirectory() ||
      !sameIdentity(rootPathMetadata, rootHandleMetadata)
    ) {
      throw new Error(
        "Linux package artifact root identity changed during admission",
      );
    }
    const artifact = {
      chromeSandbox: {
        state: "absent",
      },
      executable: undefined,
      fixedDirectories,
      fixedFiles,
      root: {
        handle: rootHandle,
        identity: {
          dev: rootHandleMetadata.dev,
          ino: rootHandleMetadata.ino,
        },
      },
      release: {
        handle: releaseHandle,
        identity: {
          dev: releaseHandleMetadata.dev,
          ino: releaseHandleMetadata.ino,
        },
      },
    };
    const chromeSandboxPath = procDescriptorPath(
      artifact.root.handle,
      "chrome-sandbox",
    );
    const chromeSandboxPathMetadata =
      await lstatIfPresent(chromeSandboxPath);
    if (chromeSandboxPathMetadata !== undefined) {
      if (
        chromeSandboxPathMetadata.isSymbolicLink() ||
        !chromeSandboxPathMetadata.isFile() ||
        chromeSandboxPathMetadata.nlink !== 1
      ) {
        throw new Error(
          "Linux package chrome-sandbox must be a privately owned regular file",
        );
      }
      chromeSandboxHandle = await open(
        chromeSandboxPath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      const chromeSandboxHandleMetadata =
        await chromeSandboxHandle.stat();
      if (
        !chromeSandboxHandleMetadata.isFile() ||
        chromeSandboxHandleMetadata.nlink !== 1 ||
        !sameIdentity(
          chromeSandboxPathMetadata,
          chromeSandboxHandleMetadata,
        )
      ) {
        throw new Error(
          "Linux package chrome-sandbox identity changed during admission",
        );
      }
      artifact.chromeSandbox = {
        handle: chromeSandboxHandle,
        identity: {
          dev: chromeSandboxHandleMetadata.dev,
          ino: chromeSandboxHandleMetadata.ino,
        },
        state: "linked",
      };
    }
    for (const relativePath of LINUX_FIXED_MODE_DIRECTORIES) {
      const admittedPath = fixedRelativePath(relativePath);
      const candidatePath = procDescriptorPath(
        fixedParentHandle(artifact, admittedPath),
        path.posix.basename(admittedPath),
      );
      const pathMetadata = await lstat(candidatePath);
      if (pathMetadata.isSymbolicLink() || !pathMetadata.isDirectory()) {
        throw new Error(
          `Linux package artifact directory is not privately owned: ${admittedPath}`,
        );
      }
      const directoryHandle = await open(
        candidatePath,
        fsConstants.O_RDONLY |
          fsConstants.O_DIRECTORY |
          fsConstants.O_NOFOLLOW,
      );
      try {
        const handleMetadata = await directoryHandle.stat();
        if (
          !handleMetadata.isDirectory() ||
          !sameIdentity(pathMetadata, handleMetadata)
        ) {
          throw new Error(
            `Linux package artifact directory identity changed: ${admittedPath}`,
          );
        }
        fixedDirectories.set(admittedPath, {
          handle: directoryHandle,
          identity: { dev: handleMetadata.dev, ino: handleMetadata.ino },
        });
      } catch (error) {
        await directoryHandle.close();
        throw error;
      }
    }
    for (const [relativePath, mode] of LINUX_FIXED_MODE_FILES) {
      const admittedPath = fixedRelativePath(relativePath);
      const candidatePath = procDescriptorPath(
        fixedParentHandle(artifact, admittedPath),
        path.posix.basename(admittedPath),
      );
      const pathMetadata = await lstat(candidatePath);
      if (
        pathMetadata.isSymbolicLink() ||
        !pathMetadata.isFile() ||
        pathMetadata.nlink !== 1
      ) {
        throw new Error(
          `Linux package artifact file is not privately owned: ${admittedPath}`,
        );
      }
      const fileHandle = await open(
        candidatePath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      try {
        const handleMetadata = await fileHandle.stat();
        if (
          !handleMetadata.isFile() ||
          handleMetadata.nlink !== 1 ||
          !sameIdentity(pathMetadata, handleMetadata)
        ) {
          throw new Error(
            `Linux package artifact file identity changed: ${admittedPath}`,
          );
        }
        fixedFiles.set(admittedPath, {
          handle: fileHandle,
          identity: { dev: handleMetadata.dev, ino: handleMetadata.ino },
          mode,
        });
      } catch (error) {
        await fileHandle.close();
        throw error;
      }
    }
    const executablePath = procDescriptorPath(rootHandle, "vellum");
    const executablePathMetadata = await lstat(executablePath);
    if (
      executablePathMetadata.isSymbolicLink() ||
      !executablePathMetadata.isFile() ||
      executablePathMetadata.nlink !== 1
    ) {
      throw new Error(
        "Linux package executable must be a privately owned regular file",
      );
    }
    executableHandle = await open(
      executablePath,
      fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
    );
    const executableHandleMetadata = await executableHandle.stat();
    if (
      !executableHandleMetadata.isFile() ||
      executableHandleMetadata.nlink !== 1 ||
      !sameIdentity(executablePathMetadata, executableHandleMetadata)
    ) {
      await executableHandle.close();
      throw new Error(
        "Linux package executable identity changed during admission",
      );
    }
    artifact.executable = {
      handle: executableHandle,
      identity: {
        dev: executableHandleMetadata.dev,
        ino: executableHandleMetadata.ino,
      },
    };
    return artifact;
  } catch (error) {
    await Promise.allSettled([
      ...[...fixedFiles.values()].map((file) => file.handle.close()),
      ...[...fixedDirectories.values()].map((directory) =>
        directory.handle.close(),
      ),
      chromeSandboxHandle?.close(),
      executableHandle?.close(),
      rootHandle?.close(),
      releaseHandle.close(),
    ]);
    throw error;
  }
};

const assertLinuxArtifactIdentity = async (artifact) => {
  const [releasePathMetadata, releaseHandleMetadata] = await Promise.all([
    lstat(LINUX_RELEASE_ROOT),
    artifact.release.handle.stat(),
  ]);
  if (
    releasePathMetadata.isSymbolicLink() ||
    !releasePathMetadata.isDirectory() ||
    !releaseHandleMetadata.isDirectory() ||
    !sameIdentity(releasePathMetadata, artifact.release.identity) ||
    !sameIdentity(releaseHandleMetadata, artifact.release.identity)
  ) {
    throw new Error("Linux package release root identity changed");
  }
  const [rootPathMetadata, rootHandleMetadata] = await Promise.all([
    lstat(procDescriptorPath(artifact.release.handle, "linux-unpacked")),
    artifact.root.handle.stat(),
  ]);
  if (
    rootPathMetadata.isSymbolicLink() ||
    !rootPathMetadata.isDirectory() ||
    !rootHandleMetadata.isDirectory() ||
    !sameIdentity(rootPathMetadata, artifact.root.identity) ||
    !sameIdentity(rootHandleMetadata, artifact.root.identity)
  ) {
    throw new Error("Linux package artifact root identity changed");
  }
  const chromeSandboxPath = procDescriptorPath(
    artifact.root.handle,
    "chrome-sandbox",
  );
  const chromeSandboxPathMetadata =
    await lstatIfPresent(chromeSandboxPath);
  if (artifact.chromeSandbox.state === "absent") {
    if (chromeSandboxPathMetadata !== undefined) {
      throw new Error(
        "Linux package artifact still contains chrome-sandbox",
      );
    }
  } else {
    const chromeSandboxHandleMetadata =
      await artifact.chromeSandbox.handle.stat();
    if (
      !chromeSandboxHandleMetadata.isFile() ||
      !sameIdentity(
        chromeSandboxHandleMetadata,
        artifact.chromeSandbox.identity,
      )
    ) {
      throw new Error("Linux package chrome-sandbox identity changed");
    }
    if (artifact.chromeSandbox.state === "linked") {
      if (
        chromeSandboxPathMetadata === undefined ||
        chromeSandboxPathMetadata.isSymbolicLink() ||
        !chromeSandboxPathMetadata.isFile() ||
        chromeSandboxPathMetadata.nlink !== 1 ||
        chromeSandboxHandleMetadata.nlink !== 1 ||
        !sameIdentity(
          chromeSandboxPathMetadata,
          artifact.chromeSandbox.identity,
        )
      ) {
        throw new Error("Linux package chrome-sandbox identity changed");
      }
    } else if (artifact.chromeSandbox.state === "retired") {
      if (chromeSandboxPathMetadata !== undefined) {
        throw new Error(
          "Linux package artifact still contains chrome-sandbox",
        );
      }
      if (chromeSandboxHandleMetadata.nlink !== 0) {
        throw new Error(
          "Linux package chrome-sandbox removal was not stable",
        );
      }
    } else {
      throw new Error("invalid Linux package chrome-sandbox state");
    }
  }
  for (const [relativePath, directory] of artifact.fixedDirectories) {
    const [pathMetadata, handleMetadata] = await Promise.all([
      lstat(
        procDescriptorPath(
          fixedParentHandle(artifact, relativePath),
          path.posix.basename(relativePath),
        ),
      ),
      directory.handle.stat(),
    ]);
    if (
      pathMetadata.isSymbolicLink() ||
      !pathMetadata.isDirectory() ||
      !handleMetadata.isDirectory() ||
      !sameIdentity(pathMetadata, directory.identity) ||
      !sameIdentity(handleMetadata, directory.identity)
    ) {
      throw new Error(
        `Linux package artifact directory identity changed: ${relativePath}`,
      );
    }
  }
  for (const [relativePath, file] of artifact.fixedFiles) {
    const [pathMetadata, handleMetadata] = await Promise.all([
      lstat(
        procDescriptorPath(
          fixedParentHandle(artifact, relativePath),
          path.posix.basename(relativePath),
        ),
      ),
      file.handle.stat(),
    ]);
    if (
      pathMetadata.isSymbolicLink() ||
      !pathMetadata.isFile() ||
      pathMetadata.nlink !== 1 ||
      !handleMetadata.isFile() ||
      handleMetadata.nlink !== 1 ||
      !sameIdentity(pathMetadata, file.identity) ||
      !sameIdentity(handleMetadata, file.identity)
    ) {
      throw new Error(
        `Linux package artifact file identity changed: ${relativePath}`,
      );
    }
  }
  const [executablePathMetadata, executableHandleMetadata] = await Promise.all([
    lstat(procDescriptorPath(artifact.root.handle, "vellum")),
    artifact.executable.handle.stat(),
  ]);
  if (
    executablePathMetadata.isSymbolicLink() ||
    !executablePathMetadata.isFile() ||
    executablePathMetadata.nlink !== 1 ||
    !executableHandleMetadata.isFile() ||
    executableHandleMetadata.nlink !== 1 ||
    !sameIdentity(executablePathMetadata, artifact.executable.identity) ||
    !sameIdentity(executableHandleMetadata, artifact.executable.identity)
  ) {
    throw new Error("Linux package executable identity changed");
  }
};

const omitLinuxChromeSandbox = async (artifact) => {
  await assertLinuxArtifactIdentity(artifact);
  if (artifact.chromeSandbox.state === "absent") return;
  if (artifact.chromeSandbox.state !== "linked") {
    throw new Error("Linux package chrome-sandbox was already retired");
  }
  const chromeSandbox = artifact.chromeSandbox;
  const chromeSandboxPath = procDescriptorPath(
    artifact.root.handle,
    "chrome-sandbox",
  );
  await unlink(chromeSandboxPath);
  artifact.chromeSandbox = {
    ...chromeSandbox,
    state: "retired",
  };
  const chromeSandboxHandleMetadata =
    await chromeSandbox.handle.stat();
  if (
    !chromeSandboxHandleMetadata.isFile() ||
    chromeSandboxHandleMetadata.nlink !== 0 ||
    !sameIdentity(chromeSandboxHandleMetadata, chromeSandbox.identity)
  ) {
    throw new Error("Linux package chrome-sandbox removal was not stable");
  }
  await assertLinuxArtifactIdentity(artifact);
};

const applyFixedLinuxArtifactModes = async (artifact) => {
  await assertLinuxArtifactIdentity(artifact);
  for (const [relativePath, file] of artifact.fixedFiles) {
    await file.handle.chmod(file.mode);
    const metadata = await file.handle.stat();
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      !sameIdentity(metadata, file.identity) ||
      (metadata.mode & 0o7777) !== file.mode
    ) {
      throw new Error(
        `Linux package artifact mode update was not stable: ${relativePath}`,
      );
    }
  }
  await assertLinuxArtifactIdentity(artifact);
};

const closeLinuxArtifact = async (artifact) => {
  const results = await Promise.allSettled([
    ...[...artifact.fixedFiles.values()].map((file) => file.handle.close()),
    ...[...artifact.fixedDirectories.values()].map((directory) =>
      directory.handle.close(),
    ),
    ...(artifact.chromeSandbox.handle === undefined
      ? []
      : [artifact.chromeSandbox.handle.close()]),
    artifact.executable.handle.close(),
    artifact.root.handle.close(),
    artifact.release.handle.close(),
  ]);
  const failure = results.find((result) => result.status === "rejected");
  if (failure !== undefined) throw failure.reason;
};

export default async function afterPack(context) {
  const platform = context.electronPlatformName;
  const policy = await loadPolicy();
  const productName = context.packager.appInfo.productName;
  const productFilename = context.packager.appInfo.productFilename;
  if (productName !== policy.productName) {
    throw new Error(
      `packaged product name mismatch: got ${productName} want ${policy.productName}`,
    );
  }
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(`unsupported Vellum Command package platform: ${platform}`);
  }
  if (
    platform === "linux" &&
    context.packager.executableName !== "vellum"
  ) {
    throw new Error("Linux package executable identity is not vellum");
  }
  const linuxArtifact =
    platform === "linux"
      ? await admitLinuxArtifact(context.appOutDir)
      : undefined;
  try {
    if (platform === "darwin") {
      const resourceDirectory = path.join(
        context.appOutDir,
        `${context.packager.appInfo.productFilename}.app`,
        "Contents",
        "Resources",
        "bin",
      );
      for (const name of [
        "vellum",
        "vellum-browser",
        "vellum-station",
        "unix-peer-pid.py",
      ]) {
        const resource = path.join(resourceDirectory, name);
        await access(resource);
        await chmod(resource, 0o755);
      }
    } else {
      await omitLinuxChromeSandbox(linuxArtifact);
      const runtimeVersion = await readFile(
        ELECTRON_RUNTIME_VERSION_PATH,
        "utf8",
      );
      if (
        !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(
          runtimeVersion,
        )
      ) {
        throw new Error(
          "materialized Electron runtime version is not canonical",
        );
      }
      // electronDist copies already include Electron's version file. Exclusive
      // create then fails with EEXIST; accept an identical pre-existing body.
      const versionPath = procDescriptorPath(
        linuxArtifact.root.handle,
        "version",
      );
      try {
        const existing = await readFile(versionPath, "utf8");
        if (existing !== runtimeVersion) {
          throw new Error(
            "package version already present and does not match the materialized Electron runtime",
          );
        }
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw error;
        }
        await writeFile(versionPath, runtimeVersion, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o644,
        });
      }
      await applyFixedLinuxArtifactModes(linuxArtifact);
    }
    const executablePath =
      platform === "darwin"
        ? path.join(context.appOutDir, `${productFilename}.app`)
        : procDescriptorPath(linuxArtifact.executable.handle);
    if (platform === "darwin") await access(executablePath);

    const fuseConfig = {
      version: FuseVersion.V1,
      resetAdHocDarwinSignature: platform === "darwin",
      strictlyRequireAllFuses: true,
    };
    for (const name of libraryFuseNames()) {
      // The trusted renderer still loads from file://. Its standard+secure custom
      // scheme migration must land before file protocol privileges can be disabled.
      fuseConfig[FuseV1Options[name]] = policy.fuses[name];
    }

    if (platform === "linux") await assertLinuxArtifactIdentity(linuxArtifact);
    const sentinelCount = await flipFuses(executablePath, fuseConfig);
    if (sentinelCount < 1 || sentinelCount > 2) {
      throw new Error(
        `unexpected Electron fuse sentinel count ${sentinelCount}`,
      );
    }
    if (platform === "linux") {
      await assertLinuxArtifactIdentity(linuxArtifact);
    }
    assertFuseWire(await getCurrentFuseWire(executablePath), policy);
  } finally {
    if (linuxArtifact !== undefined) {
      await closeLinuxArtifact(linuxArtifact);
    }
  }
}
