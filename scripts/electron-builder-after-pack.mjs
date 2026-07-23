import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  open,
  readFile,
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
    return {
      executable: {
        handle: executableHandle,
        identity: {
          dev: executableHandleMetadata.dev,
          ino: executableHandleMetadata.ino,
        },
      },
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
  } catch (error) {
    await Promise.allSettled([
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

const closeLinuxArtifact = async (artifact) => {
  const results = await Promise.allSettled([
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
    throw new Error(`unsupported Vellum package platform: ${platform}`);
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
      for (const name of ["vellum", "vellum-browser", "unix-peer-pid.py"]) {
        const resource = path.join(resourceDirectory, name);
        await access(resource);
        await chmod(resource, 0o755);
      }
    } else {
      await assertLinuxArtifactIdentity(linuxArtifact);
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
      await writeFile(
        procDescriptorPath(linuxArtifact.root.handle, "version"),
        runtimeVersion,
        {
          encoding: "utf8",
          flag: "wx",
          mode: 0o644,
        },
      );
      await assertLinuxArtifactIdentity(linuxArtifact);
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
