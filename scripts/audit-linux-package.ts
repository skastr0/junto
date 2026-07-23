import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  realpath,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listPackage, statFile } from "@electron/asar";
import { getCurrentFuseWire } from "@electron/fuses";
import { validateFuseWire } from "./audit-packaged-app";
import {
  electronBuilderLinuxDebArtifactName,
  linuxDebArtifactName,
  linuxUnpackedArtifactName,
} from "./finalize-linux-package";
import { auditLinuxPtyPlacement } from "./linux-packaged-pty-smoke";

export const LINUX_PACKAGE_NAME = "vellum";
export const LINUX_INSTALL_DIRECTORY = "/opt/Vellum Command";
export const LINUX_EXECUTABLE_NAME = "vellum";
export const LINUX_SYSTEMD_USER_UNIT = "vellum-remote.service";
export const LINUX_SYSTEMD_USER_UNIT_PATH =
  `/usr/lib/systemd/user/${LINUX_SYSTEMD_USER_UNIT}`;
export const LINUX_REMOTE_LAUNCHER_RESOURCE =
  "resources/systemd/vellum-remote-launch-v1";
export const LINUX_REMOTE_UNIT_RESOURCE =
  `resources/systemd/${LINUX_SYSTEMD_USER_UNIT}`;

export const LINUX_DEB_DEPENDENCIES = [
  "apparmor",
  "libasound2t64",
  "libatspi2.0-0t64",
  "libdrm2",
  "libgbm1",
  "libgtk-3-0t64",
  "libnotify4",
  "libnspr4",
  "libnss3",
  "libsecret-1-0",
  "libuuid1",
  "libx11-6",
  "libxcb1",
  "libxcomposite1",
  "libxdamage1",
  "libxext6",
  "libxfixes3",
  "libxkbcommon0",
  "libxrandr2",
  "libxss1",
  "libxtst6",
  "openssh-client",
  "procps",
  "python3",
  "xauth",
  "xdg-utils",
  "xvfb",
] as const;

export const EXPECTED_APPARMOR_PROFILE = `abi <abi/4.0>,
include <tunables/global>

# Ubuntu 24.04 restricts unprivileged user namespaces by AppArmor label.
# Vellum needs only the userns feature grant; the app otherwise remains
# unconfined by this compatibility profile.
profile vellum "/opt/Vellum Command/vellum" flags=(unconfined) {
  userns,
}
`;

interface PackageMetadata {
  readonly package: string;
  readonly version: string;
  readonly architecture: string;
  readonly depends: ReadonlyArray<string>;
}

export interface DebArchiveEntry {
  readonly mode: string;
  readonly owner: string;
  readonly path: string;
  readonly linkTarget?: string;
}

interface PackageTreeEntry {
  readonly kind: "directory" | "file" | "link";
  readonly mode: number;
  readonly digest?: string;
  readonly target?: string;
}

export interface LinuxPackageAuditReceipt {
  readonly ok: true;
  readonly package: typeof LINUX_PACKAGE_NAME;
  readonly version: string;
  readonly architecture: "amd64";
  readonly installDirectory: typeof LINUX_INSTALL_DIRECTORY;
  readonly dependencies: ReadonlyArray<string>;
  readonly archiveEntries: number;
  readonly nativeObjects: ReadonlyArray<string>;
  readonly fuses: Readonly<Record<string, "Enabled" | "Disabled">>;
  readonly chromeSandboxMode: "0755";
  readonly appArmor: "userns";
}

export type LinuxPackageArtifactLayout = "builder" | "canonical";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PACKAGE_JSON_PATH = path.join(PACKAGE_ROOT, "package.json");

export const validateLinuxPackageArtifactNames = ({
  unpackedName,
  debName,
  productName,
  version,
}: {
  readonly unpackedName: string;
  readonly debName: string;
  readonly productName: string;
  readonly version: string;
}): LinuxPackageArtifactLayout => {
  const canonicalUnpackedName = linuxUnpackedArtifactName({
    productName,
    version,
    arch: "x64",
  });
  const canonicalDebName = linuxDebArtifactName({
    productName,
    version,
    arch: "x64",
  });
  if (unpackedName === canonicalUnpackedName && debName === canonicalDebName) {
    return "canonical";
  }
  const builderDebName = electronBuilderLinuxDebArtifactName({
    productName,
    version,
    arch: "x64",
  });
  if (unpackedName === "linux-unpacked" && debName === builderDebName) {
    return "builder";
  }
  throw new Error(
    `Linux package artifact layout mismatch: unpacked=${unpackedName} deb=${debName}`,
  );
};

const isPathWithin = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
};

const requirePathWithin = (
  root: string,
  candidate: string,
  label: string,
): void => {
  if (!isPathWithin(root, candidate)) {
    throw new Error(`${label} escaped the audited package root`);
  }
};

const runFixed = (
  executable: string,
  args: ReadonlyArray<string>,
  options: { readonly maxBuffer?: number } = {},
): string => {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    shell: false,
    timeout: 30_000,
    maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    },
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`${path.basename(executable)} failed during Linux package audit`);
  }
  return result.stdout ?? "";
};

export const parseDebControl = (input: string): ReadonlyMap<string, string> => {
  const fields = new Map<string, string>();
  let current: string | undefined;
  for (const line of input.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    if (/^[ \t]/u.test(line)) {
      if (current === undefined) {
        throw new Error("deb control has an orphan continuation");
      }
      fields.set(current, `${fields.get(current) ?? ""}\n${line.slice(1)}`);
      continue;
    }
    const match = line.match(/^([A-Za-z0-9][A-Za-z0-9-]*):[ \t]*(.*)$/u);
    if (match === null || fields.has(match[1])) {
      throw new Error("deb control has a malformed or duplicate field");
    }
    current = match[1];
    fields.set(current, match[2]);
  }
  return fields;
};

const normalizedDependencyName = (value: string): string => {
  const match = value
    .trim()
    .match(
      /^([a-z0-9][a-z0-9+.-]*)(?::[a-z0-9-]+)?(?:\s*\([^)]*\))?$/u,
    );
  if (match === null) {
    throw new Error(`deb contains unsupported dependency syntax: ${value}`);
  }
  return match[1];
};

export const validateDebControl = (
  input: string,
  expectedVersion: string,
): PackageMetadata => {
  const fields = parseDebControl(input);
  const packageName = fields.get("Package");
  const version = fields.get("Version");
  const architecture = fields.get("Architecture");
  const dependsField = fields.get("Depends");
  if (
    packageName !== LINUX_PACKAGE_NAME ||
    version !== expectedVersion ||
    architecture !== "amd64" ||
    dependsField === undefined
  ) {
    throw new Error("deb identity, version, architecture, or dependencies mismatch");
  }
  const dependencies = dependsField
    .replaceAll("\n", " ")
    .split(",")
    .map(normalizedDependencyName)
    .sort();
  const expectedDependencies = [...LINUX_DEB_DEPENDENCIES].sort();
  if (
    dependencies.length !== expectedDependencies.length ||
    dependencies.some((dependency, index) => dependency !== expectedDependencies[index])
  ) {
    throw new Error(
      `deb dependency inventory mismatch: got ${dependencies.join(",")} want ${expectedDependencies.join(",")}`,
    );
  }
  return { package: packageName, version, architecture, depends: dependencies };
};

export const parseDebArchiveListing = (
  input: string,
): ReadonlyArray<DebArchiveEntry> => {
  const entries: DebArchiveEntry[] = [];
  for (const line of input.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    const match = line.match(
      /^([^\s]{10})\s+([^\s]+)\s+\d+\s+[^\s]+\s+[^\s]+\s+(.+)$/u,
    );
    if (match === null) {
      throw new Error("dpkg-deb returned a malformed archive listing");
    }
    const [archivePath, linkTarget] = match[3].split(" -> ", 2);
    entries.push({
      mode: match[1],
      owner: match[2] === "0/0" ? "root/root" : match[2],
      path: archivePath,
      ...(linkTarget === undefined ? {} : { linkTarget }),
    });
  }
  return entries;
};

export const validateDebArchive = (
  entries: ReadonlyArray<DebArchiveEntry>,
): ReadonlyArray<DebArchiveEntry> => {
  const installPrefix = `.${LINUX_INSTALL_DIRECTORY}/`;
  const allowedOutsideInstallTree = new Map<string, string>([
    ["./", "drwxr-xr-x"],
    ["./opt/", "drwxr-xr-x"],
    ["./usr/", "drwxr-xr-x"],
    ["./usr/share/", "drwxr-xr-x"],
    ["./usr/share/doc/", "drwxr-xr-x"],
    ["./usr/share/doc/vellum/", "drwxr-xr-x"],
    ["./usr/share/doc/vellum/changelog.gz", "-rw-r--r--"],
    ["./usr/share/applications/", "drwxr-xr-x"],
    ["./usr/share/applications/vellum.desktop", "-rw-r--r--"],
    ["./usr/share/icons/", "drwxr-xr-x"],
    ["./usr/share/icons/hicolor/", "drwxr-xr-x"],
    ["./usr/share/icons/hicolor/1024x1024/", "drwxr-xr-x"],
    ["./usr/share/icons/hicolor/1024x1024/apps/", "drwxr-xr-x"],
    ["./usr/share/icons/hicolor/1024x1024/apps/vellum.png", "-rw-r--r--"],
  ]);
  const installed = entries.filter(
    (entry) =>
      entry.path === `.${LINUX_INSTALL_DIRECTORY}` ||
      entry.path.startsWith(installPrefix),
  );
  if (installed.length === 0) throw new Error("deb is missing the Vellum install tree");
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.path)) {
      throw new Error(`deb repeats archive path ${entry.path}`);
    }
    seen.add(entry.path);
    if (entry.owner !== "root/root") {
      throw new Error(`deb archive path is not root-owned: ${entry.path}`);
    }
    if (
      entry.path !== `.${LINUX_INSTALL_DIRECTORY}` &&
      !entry.path.startsWith(installPrefix)
    ) {
      const expectedMode = allowedOutsideInstallTree.get(entry.path);
      if (expectedMode === undefined) {
        throw new Error(`deb contains an undeclared package destination: ${entry.path}`);
      }
      if (entry.mode !== expectedMode || entry.linkTarget !== undefined) {
        throw new Error(`deb system destination type or mode mismatch: ${entry.path}`);
      }
    }
    if (entry.mode[0] !== "l" && (entry.mode[5] === "w" || entry.mode[8] === "w")) {
      throw new Error(`deb archive path is group/world writable: ${entry.path}`);
    }
    if (/[sStT]/u.test(entry.mode.slice(1))) {
      throw new Error(`deb archive path carries elevated mode bits: ${entry.path}`);
    }
    if (entry.linkTarget !== undefined && entry.path.startsWith(installPrefix)) {
      if (path.posix.isAbsolute(entry.linkTarget)) {
        throw new Error(`deb install-tree symlink is absolute: ${entry.path}`);
      }
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(entry.path), entry.linkTarget),
      );
      const canonicalInstallPrefix = installPrefix.slice(2);
      if (!resolved.startsWith(canonicalInstallPrefix)) {
        throw new Error(`deb install-tree symlink escapes its package root: ${entry.path}`);
      }
    }
  }
  const requiredModes = new Map([
    [`${installPrefix}vellum`, "-rwxr-xr-x"],
    [`${installPrefix}chrome-sandbox`, "-rwxr-xr-x"],
    [`${installPrefix}resources/bin/vellum`, "-rwxr-xr-x"],
    [`${installPrefix}resources/bin/vellum-browser`, "-rwxr-xr-x"],
    [`${installPrefix}resources/bin/unix-peer-pid.py`, "-rwxr-xr-x"],
    [`${installPrefix}resources/apparmor-profile`, "-rw-r--r--"],
  ]);
  for (const [requiredPath, requiredMode] of requiredModes) {
    const entry = entries.find((candidate) => candidate.path === requiredPath);
    if (entry?.mode !== requiredMode || entry.linkTarget !== undefined) {
      throw new Error(`deb package mode mismatch for ${requiredPath}`);
    }
  }
  return installed;
};

export const validateAppArmorProfile = (input: string): void => {
  if (input !== EXPECTED_APPARMOR_PROFILE) {
    throw new Error(
      "Linux AppArmor profile differs from the qualified userns-only policy",
    );
  }
};

/** Parses the one ExecStart token which systemd must execute, not a shell. */
export const parseSystemdExecStart = (unit: string): string => {
  const lines = unit.split(/\r?\n/u).filter((line) => line.startsWith("ExecStart="));
  if (lines.length !== 1) {
    throw new Error("systemd user unit must declare exactly one ExecStart");
  }
  const command = lines[0].slice("ExecStart=".length);
  if (command.length === 0 || /[ \t]/u.test(command)) {
    throw new Error("systemd ExecStart must be a single escaped executable token");
  }
  if (/\\(?!x[0-9A-Fa-f]{2})/u.test(command)) {
    throw new Error("systemd ExecStart contains an unsupported escape");
  }
  return command.replaceAll(/\\x([0-9A-Fa-f]{2})/gu, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
};

export const validateSystemdUserUnit = (unit: string): void => {
  if (
    parseSystemdExecStart(unit) !==
      `${LINUX_INSTALL_DIRECTORY}/${LINUX_REMOTE_LAUNCHER_RESOURCE}`
  ) {
    throw new Error("systemd user unit ExecStart does not address the packaged launcher");
  }
  for (const required of [
    "Restart=on-failure",
    "TimeoutStartSec=45s",
    "TimeoutStopSec=20s",
    "KillMode=control-group",
    "ConditionFileIsExecutable=/opt/Vellum\\x20Command/vellum",
    "StandardOutput=null",
    "StandardError=null",
  ]) {
    if (!unit.includes(required)) {
      throw new Error(`systemd user unit is missing ${required}`);
    }
  }
};

export const parseDesktopEntry = (input: string): ReadonlyMap<string, string> => {
  const result = new Map<string, string>();
  let inDesktopEntry = false;
  for (const line of input.split(/\r?\n/u)) {
    if (line === "[Desktop Entry]") {
      inDesktopEntry = true;
      continue;
    }
    if (line.startsWith("[")) break;
    if (!inDesktopEntry || line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error("desktop entry contains a malformed field");
    const name = line.slice(0, separator);
    if (result.has(name)) throw new Error(`desktop entry repeats ${name}`);
    result.set(name, line.slice(separator + 1));
  }
  return result;
};

export const validateDesktopEntry = (input: string): void => {
  const fields = parseDesktopEntry(input);
  const expected = new Map([
    ["Name", "Vellum Command"],
    ["Exec", '"/opt/Vellum Command/vellum" %U'],
    ["Terminal", "false"],
    ["Type", "Application"],
    ["Icon", "vellum"],
    ["Categories", "Development;"],
    ["MimeType", "x-scheme-handler/vellum;"],
  ]);
  for (const [name, value] of expected) {
    if (fields.get(name) !== value) {
      throw new Error(`desktop entry ${name} mismatch`);
    }
  }
};

export const validateElfX64 = (header: Uint8Array, label: string): void => {
  if (
    header.byteLength < 20 ||
    header[0] !== 0x7f ||
    header[1] !== 0x45 ||
    header[2] !== 0x4c ||
    header[3] !== 0x46 ||
    header[4] !== 2 ||
    header[5] !== 1 ||
    header[18] !== 0x3e ||
    header[19] !== 0
  ) {
    throw new Error(`${label} is not an ELF64 little-endian x86-64 object`);
  }
};

const requireRegularMode = async (
  filePath: string,
  mode: 0o644 | 0o755,
): Promise<void> => {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || (metadata.mode & 0o7777) !== mode) {
    throw new Error(`Linux package file mode mismatch: ${path.basename(filePath)}`);
  }
};

const requireElfX64 = async (filePath: string): Promise<void> => {
  const handle = await open(filePath, "r");
  try {
    const bytes = Buffer.alloc(20);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    validateElfX64(bytes.subarray(0, bytesRead), path.basename(filePath));
  } finally {
    await handle.close();
  }
};

const requireLoadable = (filePath: string): void => {
  const output = runFixed("/usr/bin/ldd", [filePath]);
  if (/\bnot found\b/u.test(output)) {
    throw new Error(`Linux native object has unresolved libraries: ${path.basename(filePath)}`);
  }
};

const sha256 = (filePath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });

const snapshotPackageTree = async (
  root: string,
): Promise<ReadonlyMap<string, PackageTreeEntry>> => {
  const snapshot = new Map<string, PackageTreeEntry>();
  const walk = async (current: string, relative: string): Promise<void> => {
    const metadata = await lstat(current);
    const mode = metadata.mode & 0o7777;
    if (metadata.isSymbolicLink()) {
      const target = await readlink(current);
      if (path.isAbsolute(target)) {
        throw new Error(`package tree contains an absolute symlink: ${relative}`);
      }
      const resolved = path.resolve(path.dirname(current), target);
      requirePathWithin(root, resolved, `package symlink ${relative}`);
      snapshot.set(relative, { kind: "link", mode, target });
      return;
    }
    if (metadata.isFile()) {
      snapshot.set(relative, {
        kind: "file",
        mode,
        digest: await sha256(current),
      });
      return;
    }
    if (!metadata.isDirectory()) {
      throw new Error(`package tree contains a non-file object: ${relative}`);
    }
    snapshot.set(relative, { kind: "directory", mode });
    const children = await readdir(current);
    children.sort();
    for (const child of children) {
      await walk(
        path.join(current, child),
        relative === "." ? child : `${relative}/${child}`,
      );
    }
  };
  await walk(root, ".");
  return snapshot;
};

const requireIdenticalPackageTrees = async (
  unpacked: string,
  extracted: string,
): Promise<void> => {
  const [unpackedTree, extractedTree] = await Promise.all([
    snapshotPackageTree(unpacked),
    snapshotPackageTree(extracted),
  ]);
  if (unpackedTree.size !== extractedTree.size) {
    throw new Error("deb install tree inventory differs from the unpacked artifact");
  }
  for (const [relative, expected] of unpackedTree) {
    const actual = extractedTree.get(relative);
    if (
      actual === undefined ||
      actual.kind !== expected.kind ||
      actual.mode !== expected.mode ||
      actual.digest !== expected.digest ||
      actual.target !== expected.target
    ) {
      throw new Error(`deb install tree differs at ${relative}`);
    }
  }
};

const requireSameFile = async (left: string, right: string): Promise<void> => {
  if ((await sha256(left)) !== (await sha256(right))) {
    throw new Error(`deb payload differs from unpacked artifact: ${path.basename(left)}`);
  }
};

const assertAsarUnpacked = (
  asarPath: string,
  physicalPath: string,
  resources: string,
): void => {
  const unpackedRoot = path.join(resources, "app.asar.unpacked");
  requirePathWithin(unpackedRoot, physicalPath, "node-pty native object");
  const relative = path.relative(unpackedRoot, physicalPath).split(path.sep).join("/");
  if (statFile(asarPath, relative).unpacked !== true) {
    throw new Error(`ASAR does not mark ${relative} as unpacked`);
  }
};

const validateNodePtyAsarInventory = (
  asarPath: string,
  nativeModule: string,
  resources: string,
): void => {
  const unpackedRoot = path.join(resources, "app.asar.unpacked");
  const nativeModuleRelative = path.relative(unpackedRoot, nativeModule).split(path.sep).join("/");
  const isAllowedNativeModule = (relative: string): boolean =>
    relative === nativeModuleRelative ||
    /^node_modules\/node-pty\/bin\/linux-x64-[^/]+\/node-pty\.node$/u.test(relative);
  for (const entry of listPackage(asarPath, { isPack: false })) {
    const normalized = entry.replace(/^\//u, "");
    if (
      normalized.startsWith("node_modules/node-pty/prebuilds/") &&
      !normalized.startsWith("node_modules/node-pty/prebuilds/linux-x64/")
    ) {
      throw new Error(`ASAR contains a foreign node-pty prebuild: ${normalized}`);
    }
    if (
      normalized.endsWith(".node") &&
      normalized.startsWith("node_modules/node-pty/") &&
      statFile(asarPath, normalized).unpacked === true &&
      !isAllowedNativeModule(normalized)
    ) {
      throw new Error(`ASAR unpacks an undeclared node-pty native file: ${normalized}`);
    }
  }
};

const requireSingleIcon = async (extractedRoot: string): Promise<void> => {
  const iconRoot = path.join(extractedRoot, "usr", "share", "icons", "hicolor");
  const sizes = await readdir(iconRoot);
  const matches: string[] = [];
  for (const size of sizes) {
    const candidate = path.join(iconRoot, size, "apps", "vellum.png");
    try {
      await access(candidate, fsConstants.R_OK);
      matches.push(candidate);
    } catch {
      // Other theme sizes are unrelated.
    }
  }
  if (
    matches.length !== 1 ||
    !matches[0].includes(`${path.sep}1024x1024${path.sep}`)
  ) {
    throw new Error("deb must contain the exact 1024x1024 Vellum desktop icon");
  }
};

export const auditLinuxPackage = async ({
  unpackedPath,
  debPath,
}: {
  readonly unpackedPath: string;
  readonly debPath: string;
}): Promise<LinuxPackageAuditReceipt> => {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Linux package audit requires native Linux x64");
  }
  const packageJson = JSON.parse(await readFile(PACKAGE_JSON_PATH, "utf8")) as {
    readonly version?: unknown;
    readonly build?: { readonly productName?: unknown };
  };
  if (
    typeof packageJson.version !== "string" ||
    packageJson.build?.productName !== "Vellum Command"
  ) {
    throw new Error("package metadata is missing the canonical Linux identity");
  }

  const unpacked = await realpath(path.resolve(unpackedPath));
  const deb = await realpath(path.resolve(debPath));
  validateLinuxPackageArtifactNames({
    unpackedName: path.basename(unpacked),
    debName: path.basename(deb),
    productName: packageJson.build.productName,
    version: packageJson.version,
  });
  if (!(await stat(unpacked)).isDirectory() || !(await stat(deb)).isFile()) {
    throw new Error("Linux package audit requires an unpacked directory and deb file");
  }

  const control = validateDebControl(
    runFixed("/usr/bin/dpkg-deb", ["--field", deb]),
    packageJson.version,
  );
  const archiveEntries = parseDebArchiveListing(
    runFixed("/usr/bin/dpkg-deb", ["--contents", deb], {
      maxBuffer: 32 * 1024 * 1024,
    }),
  );
  validateDebArchive(archiveEntries);

  const extraction = await mkdtemp(path.join(tmpdir(), "vellum-linux-deb-audit-"));
  try {
    const controlDirectory = path.join(extraction, "control");
    await mkdir(controlDirectory, { mode: 0o700 });
    runFixed("/usr/bin/dpkg-deb", ["--control", deb, controlDirectory]);
    const postInstall = path.join(controlDirectory, "postinst");
    const postRemove = path.join(controlDirectory, "postrm");
    const preInstall = path.join(controlDirectory, "preinst");
    const preRemove = path.join(controlDirectory, "prerm");
    await Promise.all([
      requireRegularMode(preInstall, 0o755),
      requireRegularMode(preRemove, 0o755),
      requireRegularMode(postInstall, 0o755),
      requireRegularMode(postRemove, 0o755),
      requireSameFile(
        preInstall,
        path.join(PACKAGE_ROOT, "build", "linux", "before-install.sh"),
      ),
      requireSameFile(
        preRemove,
        path.join(PACKAGE_ROOT, "build", "linux", "before-remove.sh"),
      ),
      requireSameFile(
        postInstall,
        path.join(PACKAGE_ROOT, "build", "linux", "after-install.sh"),
      ),
      requireSameFile(
        postRemove,
        path.join(PACKAGE_ROOT, "build", "linux", "after-remove.sh"),
      ),
    ]);
    const controlEntries = await readdir(controlDirectory);
    const allowedControlEntries = new Set([
      "control",
      "md5sums",
      "postinst",
      "postrm",
      "preinst",
      "prerm",
    ]);
    if (controlEntries.some((entry) => !allowedControlEntries.has(entry))) {
      throw new Error("deb contains an undeclared control-plane file");
    }

    runFixed("/usr/bin/dpkg-deb", ["--extract", deb, extraction]);
    const extractedApp = path.join(
      extraction,
      ...LINUX_INSTALL_DIRECTORY.slice(1).split("/"),
    );
    const extractedReal = await realpath(extractedApp);
    requirePathWithin(extraction, extractedReal, "deb install tree");
    await requireIdenticalPackageTrees(unpacked, extractedReal);

    const resources = path.join(extractedReal, "resources");
    const mainExecutable = path.join(extractedReal, LINUX_EXECUTABLE_NAME);
    const chromeSandbox = path.join(extractedReal, "chrome-sandbox");
    const appAsar = path.join(resources, "app.asar");
    const workCli = path.join(resources, "bin", "vellum");
    const browserCli = path.join(resources, "bin", "vellum-browser");
    const peerPidHelper = path.join(resources, "bin", "unix-peer-pid.py");
    const appArmorProfile = path.join(resources, "apparmor-profile");
    const remoteLauncher = path.join(extractedReal, LINUX_REMOTE_LAUNCHER_RESOURCE);
    const remoteUnit = path.join(extractedReal, LINUX_REMOTE_UNIT_RESOURCE);

    await Promise.all([
      requireRegularMode(mainExecutable, 0o755),
      requireRegularMode(chromeSandbox, 0o755),
      requireRegularMode(workCli, 0o755),
      requireRegularMode(browserCli, 0o755),
      requireRegularMode(peerPidHelper, 0o755),
      requireRegularMode(appArmorProfile, 0o644),
      requireRegularMode(remoteLauncher, 0o755),
      requireRegularMode(remoteUnit, 0o644),
      requireRegularMode(appAsar, 0o644),
    ]);
    validateAppArmorProfile(await readFile(appArmorProfile, "utf8"));
    validateSystemdUserUnit(await readFile(remoteUnit, "utf8"));

    const pty = auditLinuxPtyPlacement(resources);
    assertAsarUnpacked(appAsar, pty.nativeModule, resources);
    validateNodePtyAsarInventory(
      appAsar,
      pty.nativeModule,
      resources,
    );
    const elfObjects = [
      mainExecutable,
      workCli,
      browserCli,
      pty.nativeModule,
    ];
    await Promise.all(elfObjects.map(requireElfX64));
    requireLoadable(mainExecutable);
    requireLoadable(pty.nativeModule);

    const fuseReceipt = validateFuseWire(await getCurrentFuseWire(mainExecutable));
    validateDesktopEntry(
      await readFile(
        path.join(
          extraction,
          "usr",
          "share",
          "applications",
          "vellum.desktop",
        ),
        "utf8",
      ),
    );
    await requireSingleIcon(extraction);

    return {
      ok: true,
      package: LINUX_PACKAGE_NAME,
      version: control.version,
      architecture: "amd64",
      installDirectory: LINUX_INSTALL_DIRECTORY,
      dependencies: control.depends,
      archiveEntries: archiveEntries.length,
      nativeObjects: elfObjects.map((entry) =>
        path.relative(extractedReal, entry),
      ),
      fuses: fuseReceipt,
      chromeSandboxMode: "0755",
      appArmor: "userns",
    };
  } finally {
    await rm(extraction, { recursive: true, force: true });
  }
};

const modulePath = fileURLToPath(import.meta.url);
const invokedPath =
  process.argv[1] === undefined ? "" : path.resolve(process.argv[1]);
if (modulePath === invokedPath) {
  const args = process.argv.slice(2);
  const unpackedIndex = args.indexOf("--unpacked");
  const debIndex = args.indexOf("--deb");
  if (
    args.length !== 4 ||
    unpackedIndex < 0 ||
    debIndex < 0 ||
    args[unpackedIndex + 1] === undefined ||
    args[debIndex + 1] === undefined
  ) {
    console.error(
      "usage: bun scripts/audit-linux-package.ts --unpacked <directory> --deb <file>",
    );
    process.exitCode = 2;
  } else {
    auditLinuxPackage({
      unpackedPath: args[unpackedIndex + 1],
      debPath: args[debIndex + 1],
    })
      .then((receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`vellum Linux package audit failed: ${message.slice(0, 1_000)}`);
        process.exitCode = 1;
      });
  }
}
